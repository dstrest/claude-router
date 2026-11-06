import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acceptActivity } from '../lib/activity.mjs';
import { emptySession, LATENCY_BOUNDS, latencyP95, recordTurn } from '../lib/activity-stats.mjs';
import { ClassifierClient } from '../lib/classifier-client.mjs';
import { resolveCredentials } from '../lib/classifier-contract.mjs';
import { activeClassifier, DEFAULTS, ROUTING_MODES, TIERS } from '../lib/config.mjs';
import { classifierStatus, classifierWarns, NOT_A_TIER_REASON } from '../lib/display.mjs';
import { observedActivity, promptIndex, routingBucket } from '../lib/facts.mjs';
import { applyMode, modeLabel, readProjectMode, resolveRoutingMode } from '../lib/modes.mjs';
import {
  canMoveUp,
  cellForModel,
  chooseRoute,
  continueRoute,
  emptyLoop,
  isModelAllowed,
  isNativeFallback,
  nativeFacts,
  observedMove,
  observeResponse,
  prepareLoop,
  resetHistory,
} from '../lib/route.mjs';
import { compareModels } from '../lib/savings.mjs';
import { classifiedAlias, PASS_LABEL, passReason, SPAWN_DEADLINE_MS, spawnPrompt } from '../lib/subagents.mjs';
import {
  emptyUsage,
  mergeUsage,
  PERIODS,
  readUsage,
  recordUsage,
  replyEntry,
  usageAfterReset,
  withReplies,
} from '../lib/usage.mjs';
import {
  availableModelIds,
  classifierLabel,
  formatModelRef,
  modelId,
  modelOptions,
  normalizeOptions,
  parseModelRef,
  routerConfig,
  sameModel,
  variantOf,
} from './config.mjs';
import { promptHasImages, routerMessages, stopReasonOf, usageOf } from './messages.mjs';
import { atHostCost, usageReport } from './usage.mjs';

function sleep(ms, { signal }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('cancelled'));
      },
      { once: true },
    );
  });
}

// The host turns a rejected session hook into a defect that loses the prompt, and a throw would end the event loop.
const failOpen =
  (handler) =>
  async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      console.error('OpenCode router failed open', error);
    }
  };

// Nothing from an earlier routed turn stays once routing stops choosing.
const NO_ROUTE = { tier: null, activity: null, adviceChoice: null, activityChoice: null, tierConfidence: null };

const PROFILE_KEY = 'profile';
const sessionKey = (sessionID) => `session:${sessionID}`;
const USAGE_PREFIX = 'usage:';
const usageKey = (sessionID) => `${USAGE_PREFIX}${sessionID}`;
const HISTORY_RESET_KEY = 'history-reset';
// shortcut: OpenCode reports no cache lifetime, so writes price at five minutes; atHostCost corrects the total.
const CACHE_TTL = '5m';
const DECISIONS_KEPT = 100;

const initialState = (session) => ({
  sessionID: session.id,
  parentID: session.parentID ?? null,
  agent: session.agent ?? null,
  mode: 'auto',
  phase: 'ready',
  activeModel: session.model ?? null,
  nextModel: session.model ?? null,
  nativeModel: session.model ?? null,
  tier: null,
  tierConfidence: null,
  tierProbability: null,
  activity: null,
  activityChoice: null,
  activityProbability: null,
  reason: 'ready',
  error: null,
  pendingPin: null,
  switches: 0,
  switching: false,
  fixed: false,
  owned: false,
  adviceChoice: null,
  usageVersion: 0,
  modeOverride: null,
  comparedModel: null,
  usage: emptyUsage(),
  turnEntries: [],
  turnSwitched: null,
  stats: emptySession(),
  adviceBuckets: Array(LATENCY_BOUNDS.length + 1).fill(0),
  lastAnswer: null,
  loop: null,
  observedAt: null,
  generation: 0,
  sequence: 0,
  updatedAt: Date.now(),
  decisions: [],
});

export async function createController(ctx, options = {}, dependencies = {}) {
  // Saved settings overlay the plugin options, a tier at a time, so a later config edit reaches every other tier.
  const withProfile = (saved) => ({ ...options, ...saved, routes: { ...options.routes, ...saved.routes } });
  let profile = {};
  let config = normalizeOptions(options);
  // Storage is shared by every project on the server, so another controller may have written since this one read.
  async function loadProfile() {
    const saved = await ctx.storage.get(PROFILE_KEY).catch(() => null);
    try {
      config = normalizeOptions(withProfile(saved ?? {}));
      profile = saved ?? {};
    } catch (error) {
      console.error('OpenCode router ignored saved settings', error);
    }
  }
  await loadProfile();
  let previousProfile = null;
  const sessions = new Map();
  const reviews = new Map();
  const loading = new Map();
  const turnConfigs = new Map();
  // Shared so one session's failures pause the classifier for all, and not exclusive so sessions do not answer each other `busy`.
  const client = new ClassifierClient({ exclusive: false });
  // A breaker of its own, so spawn failures never pause routing of the main turn.
  const spawnClient = new ClassifierClient({ exclusive: false });
  const controller = new AbortController();
  let publish = async () => {};

  async function listModels() {
    const result = await ctx.model.list();
    return Array.isArray(result) ? result : (result.data ?? result.models);
  }

  // Uses OpenCode's stored OpenRouter connection, so no key lives in plugin options or config files.
  async function openRouterKey() {
    const connection = await ctx.integration.connection.active('openrouter');
    const credential = connection && (await ctx.integration.connection.resolve(connection));
    return credential?.key ?? null;
  }

  // A session whose model no route runs was chosen by hand, so routing starts off, as it does for Claude. An unknown
  // catalog leaves it on: the routes are still checked when the turn reads them.
  async function startsOff({ nativeModel, parentID }) {
    if (parentID || !nativeModel) return false;
    try {
      return cellForModel(routerConfig(config, await listModels(), nativeModel), modelId(nativeModel)) === null;
    } catch {
      return false;
    }
  }

  // What "no routing" would have run. A subagent would have inherited its parent's model, unless its agent names one.
  async function comparedModelOf(state, session) {
    if (!session.parentID) return null;
    if ((await agentDefinition(state.agent))?.model) return state.nativeModel;
    const parent = await ensure(session.parentID).catch(() => null);
    return parent?.comparedModel ?? parent?.nativeModel ?? state.nativeModel;
  }

  // What a session keeps across a restart. The models stay as the host reports them now.
  function restore(state, saved) {
    const { activeModel, nextModel, parentID, agent, sessionID } = state;
    const phase = saved.mode === 'manual' ? 'manual' : 'ready';
    Object.assign(state, saved, {
      activeModel,
      nextModel,
      parentID,
      agent,
      sessionID,
      phase,
      switching: false,
      owned: false,
    });
  }

  function ensure(sessionID) {
    if (sessions.has(sessionID)) return sessions.get(sessionID);
    // One read per session: a TUI snapshot can race the prompt hook, and each decision must land on the same state.
    if (!loading.has(sessionID))
      loading.set(
        sessionID,
        ctx.session
          .get({ sessionID })
          .then(async (session) => {
            const state = initialState(session);
            const saved = await ctx.storage.get(sessionKey(sessionID)).catch(() => null);
            state.usage = readUsage(await ctx.storage.get(usageKey(sessionID)).catch(() => null));
            if (saved) restore(state, saved);
            else if (await startsOff(state))
              Object.assign(state, { mode: 'manual', phase: 'manual', reason: NOT_A_TIER_REASON });
            state.comparedModel ??= await comparedModelOf(state, session);
            sessions.set(sessionID, state);
            return state;
          })
          .finally(() => loading.delete(sessionID)),
      );
    return loading.get(sessionID);
  }

  async function update(state) {
    state.sequence += 1;
    state.updatedAt = Date.now();
    await publish(await sessionSnapshot(state));
    const { usage: _usage, ...saved } = state;
    await ctx.storage.set(sessionKey(state.sessionID), JSON.parse(JSON.stringify(saved))).catch((error) => {
      console.error('OpenCode router could not save a session', error);
    });
  }

  async function projectMode() {
    const text = await readFile(join(ctx.location.directory, '.opencode/router.json'), 'utf8').catch(() => null);
    const project = readProjectMode(text);
    return { ...project, error: project.error?.replace('.claude/', '.opencode/') ?? null };
  }

  // Session, then project, then profile. A pin runs its configured route, so it takes the balanced routes.
  async function routingModeOf(state) {
    const project = await projectMode();
    const routing = resolveRoutingMode({ session: state.modeOverride, project: project.mode, profile: config.mode });
    return { routing, projectError: project.error };
  }

  // A saved, shared setting: validated as options are, then applied to every session.
  async function saveProfile(next) {
    config = normalizeOptions(withProfile(next));
    profile = next;
    await (Object.keys(profile).length ? ctx.storage.set(PROFILE_KEY, profile) : ctx.storage.remove(PROFILE_KEY));
    await Promise.all([...sessions.values()].map(update));
  }

  async function changeProfile(edit) {
    await loadProfile();
    const before = profile;
    await saveProfile(edit(profile));
    previousProfile = before;
  }

  async function sessionSnapshot({ loop: _loop, usage: _usage, turnEntries: _entries, ...state }) {
    const { routing, projectError } = await routingModeOf(state);
    return {
      ...structuredClone(state),
      classifier: { id: config.classifier, label: classifierLabel(config) },
      classifiers: Object.entries(config.classifiers).map(([id, entry]) => ({ id, label: entry.label })),
      routingMode: modeLabel(routing),
      projectError,
      canUndo: previousProfile !== null,
      activityRouting: config.activityRouting,
      routes: Object.fromEntries(Object.entries(config.routeRefs).map(([tier, ref]) => [tier, formatModelRef(ref)])),
      activityRoutes: Object.fromEntries(
        Object.entries(config.activityRefs).map(([activity, routes]) => [
          activity,
          Object.fromEntries(Object.entries(routes).map(([tier, ref]) => [tier, formatModelRef(ref)])),
        ]),
      ),
    };
  }

  function cancelReview(sessionID) {
    reviews.get(sessionID)?.abort();
    reviews.delete(sessionID);
  }

  function classifierProblem(cfg, error) {
    if (!classifierWarns(error)) return null;
    const status = classifierStatus(cfg, error);
    return error === 'paused' ? `${status} until ${new Date(client.pausedUntil).toLocaleTimeString()}` : status;
  }

  async function ask(state, cfg, facts, abort = controller.signal, classifier = client) {
    const credentials = await resolveCredentials(activeClassifier(cfg), async (name) => {
      const env = name.toUpperCase();
      return ctx.options[name] || process.env[env] || (name === 'openrouter_api_key' ? openRouterKey() : null);
    });
    const signal = AbortSignal.any([controller.signal, abort]);
    const { prompt, turns } = facts;
    const request = async (url, init) => {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(activeClassifier(cfg).timeoutMs + 100)]);
      const response = await fetch(url, { ...init, signal: requestSignal });
      return {
        ok: response.ok,
        status: response.status,
        text: await response.text(),
        headers: Object.fromEntries(response.headers),
      };
    };
    const result = dependencies.ask
      ? await dependencies.ask({ config: cfg, prompt, turns, state, signal })
      : await classifier.ask({
          request,
          sleep,
          config: cfg,
          apiKey: credentials.apiKey,
          endpoint: credentials.endpoint,
          prompt,
          turns,
          signal,
        });
    return { advice: result.advice, error: classifierProblem(cfg, result.error) };
  }

  function record(state, origin, decision, ref) {
    state.decisions.unshift({
      at: Date.now(),
      origin,
      classifier: classifierLabel(config),
      tier: decision.tier ?? null,
      confidence: decision.confidence === undefined ? state.tierConfidence : decision.confidence,
      activity: decision.activity ?? null,
      reason: decision.reason,
      model: formatModelRef(ref ?? state.nextModel),
    });
    state.decisions.length = Math.min(state.decisions.length, DECISIONS_KEPT);
  }

  // An agent's definition as lib/subagents.mjs reads it, or null when the host has none.
  async function agentDefinition(agentID) {
    try {
      const result = await ctx.agent.get({ agentID });
      const info = result?.data ?? result;
      return info ? { model: info.model ? formatModelRef(info.model) : null, modelRouting: null } : null;
    } catch {
      return null;
    }
  }

  // The config stays frozen for a turn: a route edit reaches the next turn, not a step of this one.
  async function turnConfig(state) {
    if (!turnConfigs.has(state.sessionID)) {
      const catalog = await listModels();
      const configured = routerConfig(config, catalog, state.nativeModel, state.comparedModel);
      const { routing } = await routingModeOf(state);
      turnConfigs.set(state.sessionID, {
        cfg: state.pendingPin ? configured : applyMode(configured, routing),
        availableModels: availableModelIds(catalog),
        nativeModel: modelId(state.nativeModel),
      });
    }
    return turnConfigs.get(state.sessionID);
  }

  // Replies since the last read. Reading stored messages, not step events, keeps usage in step with the transcript. A
  // first read that finds replies is a session from before this controller: only its last counts, which is enough to
  // measure the context. A first read that finds none starts the count from nothing.
  function observe(cfg, loop, state, stored) {
    const replies = stored.filter(
      (message) => message?.type === 'assistant' && message.tokens && message.time?.completed,
    );
    const unseen =
      state.observedAt === null
        ? replies.slice(-1)
        : replies.filter((message) => message.time.completed > state.observedAt);
    state.observedAt = replies.at(-1)?.time.completed ?? state.observedAt ?? 0;
    return unseen.reduce((next, message) => measure(cfg, next, state, message), loop);
  }

  function measure(cfg, loop, state, message) {
    const usage = usageOf(message);
    const effort = variantOf(message.model);
    const now = message.time.completed;
    const observed = observeResponse(cfg, loop, {
      usage,
      requestedModel: modelId(message.model),
      effort,
      stopReason: stopReasonOf(message),
      now,
    });
    try {
      const yours = modelId(state.comparedModel ?? state.nativeModel);
      const served = { model: usage.model, effort };
      const args = { usage, served, effort: null, ttl: CACHE_TTL, now, yours };
      const compared = compareModels(cfg, observed.yoursBy ?? {}, args);
      const byId = Object.entries(compared.replies).map(([alias, reply]) => [
        cfg.models[alias].id,
        atHostCost(reply, message.cost),
      ]);
      state.turnEntries.push(
        replyEntry({
          at: now,
          mode: cfg.routingMode?.mode ?? DEFAULTS.mode,
          activity: observed.decision?.activity ?? null,
          tier: observed.decision?.tier ?? null,
          route: `${usage.model}@${effort ?? 'session'}`,
          yours,
          reply: atHostCost(compared.reply, message.cost),
          observedUsd: message.cost ?? 0,
          replies: Object.fromEntries(byId),
          usage,
        }),
      );
      return { ...observed, yoursBy: compared.states };
    } catch (error) {
      // The ledger never breaks a turn.
      console.error('OpenCode router could not price a reply', error);
      return observed;
    }
  }

  // A finished turn in the ledger, and what the classifier said against what its tools did.
  async function finishTurn(state, messages) {
    const resetAt = await historyResetAt();
    state.turnEntries = state.turnEntries.filter((entry) => !resetAt || entry.at >= resetAt);
    const { lastAnswer, turnSwitched: switched, turnEntries: entries } = state;
    if (lastAnswer) {
      const observed = routingBucket(observedActivity(messages, promptIndex(messages)));
      state.stats = recordTurn(state.stats, {
        activity: lastAnswer.activity,
        answer: lastAnswer.activity,
        observed,
        tierSwitches: 0,
        activitySwitches: 0,
      });
      state.lastAnswer = null;
    }
    state.turnSwitched = null;
    if (!entries.length) return;
    state.turnEntries = [];
    state.usageVersion += 1;
    // Another project may have deleted history, so a record from before that must not be added to and kept.
    state.usage = recordUsage(usageAfterReset(state.usage, resetAt), entries, { switched, now: Date.now() });
    await ctx.storage.set(usageKey(state.sessionID), state.usage).catch((error) => {
      console.error('OpenCode router could not save usage', error);
    });
  }

  async function historyResetAt() {
    return (await ctx.storage.get(HISTORY_RESET_KEY).catch(() => null)) ?? null;
  }

  async function allUsageKeys() {
    const keys = [];
    let after;
    do {
      const page = await ctx.storage.scan({ prefix: USAGE_PREFIX, after, limit: 100 });
      keys.push(...page.entries);
      after = page.next;
    } while (after);
    return keys;
  }

  // What a decision reads now: the frozen config, the transcript, and the usage and facts it gives.
  async function read(state, { prompt = state.lastPrompt, turnId = state.loop?.turnId, promptImages = false } = {}) {
    const turn = await turnConfig(state);
    const stored = await ctx.session.context({ sessionID: state.sessionID });
    const messages = routerMessages(stored);
    state.loop = observe(
      turn.cfg,
      prepareLoop(state.loop ?? emptyLoop(turn.cfg, turn.nativeModel), messages.length),
      state,
      stored,
    );
    const last = state.loop.lastRequest;
    const empty = messages.length === 0;
    const facts = nativeFacts(turn.cfg, state.loop, {
      messages,
      prompt,
      effort: null,
      turnId,
      contextTokens: last ? last.tokens + last.outputTokens : empty ? 0 : null,
    });
    if (promptImages) facts.hasImages = true;
    return { ...turn, facts, messages, stored, empty, contextKnown: Boolean(last) || empty };
  }

  function showDecision(state, decision, advice) {
    // A move without new advice: the last reading was about another tier.
    if (advice === undefined && decision.tier !== state.tier) state.tierProbability = null;
    Object.assign(state, { tier: decision.tier, activity: decision.activity ?? null, reason: decision.reason });
    if (advice === undefined) return;
    const activity = advice?.activity;
    Object.assign(state, {
      adviceChoice: advice?.choice ?? null,
      tierConfidence: advice?.confidence ?? null,
      tierProbability: advice?.probabilities?.[decision.tier] ?? null,
      activityChoice: activity?.choice ?? null,
      activityProbability: activity?.probabilities?.[activity.choice] ?? null,
    });
  }

  // `switching` covers the wait: a prompt arriving meanwhile can see the new model before `nextModel` does.
  async function switchTo(state, model) {
    state.switching = true;
    try {
      await ctx.session.switchModel({ sessionID: state.sessionID, model });
      state.nextModel = model;
    } finally {
      state.switching = false;
    }
  }

  // Turning routing off, by command or by choosing a model. The classifier's work for the turn stops with it.
  function turnOff(state, reason) {
    cancelReview(state.sessionID);
    Object.assign(state, { mode: 'manual', phase: 'manual', reason, pendingPin: null, error: null, ...NO_ROUTE });
  }

  // Applies a selected loop. It is taken first, so a step arriving during the switch sees it, and undone if the host
  // refuses: the state and the decision row only ever describe a switch that happened.
  async function commit(state, selected, origin, advice) {
    const { decision } = selected;
    const ref = decision.route ? parseModelRef(decision.route.model) : state.nativeModel;
    const previous = state.loop;
    state.loop = { ...selected, engineModel: modelId(state.nextModel) };
    state.phase = state.mode === 'manual' ? 'manual' : 'routed';
    if (ref && !sameModel(state.nextModel, ref)) {
      try {
        await switchTo(state, ref);
        state.turnSwitched = decision.tier === previous.lastRoute ? 'activity' : 'tier';
      } catch (error) {
        state.loop = previous;
        state.reason = 'model-unavailable';
        state.error = error instanceof Error ? error.message : String(error);
        await update(state);
        return;
      }
      state.switches += 1;
    }
    showDecision(state, decision, advice);
    if (decision.pinned) state.pendingPin = null;
    record(state, origin, decision, ref);
    await update(state);
  }

  const choose = (state, turn, { advice, pin = null, facts = turn.facts }) => {
    const input = {
      facts,
      advice,
      pin,
      nativeModel: turn.nativeModel,
      contextKnown: turn.contextKnown,
      availableModels: turn.availableModels,
      now: Date.now(),
    };
    if (!turn.empty) return chooseRoute(turn.cfg, state.loop, input);
    // A session with no history has nothing to overflow, so the unmeasured-shrink hold has nothing to protect. The
    // one-vote rule for an unmeasured history still applies through the facts.
    const measured = chooseRoute(turn.cfg, { ...state.loop, historyMeasured: true }, input);
    return { ...measured, historyMeasured: state.loop.historyMeasured };
  };

  async function review(state, turn) {
    const abort = new AbortController();
    reviews.set(state.sessionID, abort);
    const { generation } = state.loop;
    const observedUpTo = turn.messages.length;
    state.loop = { ...state.loop, reviewedAt: state.loop.requests };
    try {
      const result = await ask(state, turn.cfg, turn.facts, abort.signal);
      // A failed review is a no-op, and an answer about a history compaction or a rewind replaced is dropped.
      if (abort.signal.aborted || controller.signal.aborted || state.mode !== 'auto' || !result.advice) return;
      if (state.loop.generation !== generation) return;
      // Only the advice is from the review; the checkpoint, context and cache facts are read now.
      const current = await read(state);
      if (abort.signal.aborted) return;
      const facts = { ...current.facts, midTurn: true };
      await commit(state, choose(state, current, { advice: result.advice, facts }), 'review', result.advice);
      // Tool calls up to the review's snapshot were judged by it; later ones can still move the route up.
      state.loop = { ...state.loop, observedFrom: observedUpTo };
    } catch (error) {
      console.error('OpenCode router review failed', error);
    } finally {
      if (reviews.get(state.sessionID) === abort) reviews.delete(state.sessionID);
    }
  }

  // A step whose turn shows stronger work than its route was chosen for moves up once.
  async function moveOnObserved(state, { cfg, messages, facts, contextKnown }) {
    const { loop } = state;
    if (!canMoveUp(cfg, loop.decision, null)) return;
    const from = Math.max(promptIndex(messages), (loop.observedFrom ?? 0) - 1);
    const observed = routingBucket(observedActivity(messages, from));
    const moved = observedMove(cfg, loop, { observed, facts, contextKnown, now: Date.now() });
    if (moved !== loop) await commit(state, moved, 'observed');
  }

  function timeAdvice(state, startedAt) {
    const ms = Date.now() - startedAt;
    const bucket = LATENCY_BOUNDS.findIndex((bound) => ms <= bound);
    state.adviceBuckets[bucket === -1 ? LATENCY_BOUNDS.length : bucket] += 1;
  }

  // A spawn's model, from its task text alone. The wait delays the subagent's start, so it is capped.
  async function decideSpawn(parent, turn, task) {
    const { cfg } = turn;
    const entry = activeClassifier(cfg);
    const timeoutMs = Math.min(entry.timeoutMs, SPAWN_DEADLINE_MS);
    const capped = { ...cfg, classifiers: { ...cfg.classifiers, [cfg.classifier]: { ...entry, timeoutMs } } };
    const facts = { prompt: spawnPrompt(cfg, task), turns: [] };
    const { advice } = await ask(parent, capped, facts, controller.signal, spawnClient);
    const alias = classifiedAlias(cfg, advice);
    const allowed = alias && isModelAllowed(cfg.models[alias].id, turn.availableModels, turn.nativeModel);
    return { advice, model: allowed ? alias : null };
  }

  async function routeStep(state, model) {
    const turn = await read(state);
    if (isNativeFallback(state.loop, modelId(model))) {
      state.reason = 'native-fallback';
      return;
    }
    await moveOnObserved(state, turn);
    const selected = continueRoute(turn.cfg, state.loop, {
      hasImages: turn.facts.hasImages,
      nativeModel: turn.nativeModel,
      contextTokens: turn.facts.contextTokens,
      contextKnown: turn.contextKnown,
      availableModels: turn.availableModels,
      effort: null,
    });
    if (selected.decision !== state.loop.decision) await commit(state, selected, 'step');
    const { decision, requests, reviewedAt } = state.loop;
    const every = turn.cfg.policy.reviewEveryRequests;
    if (every === 0 || !decision.tier || decision.pinned || reviews.has(state.sessionID)) return;
    if (requests - reviewedAt >= every) void review(state, turn);
  }

  return {
    setPublisher(handler) {
      publish = handler;
    },
    async snapshot(sessionID) {
      return sessionSnapshot(await ensure(sessionID));
    },
    async models() {
      return { models: modelOptions(await listModels()) };
    },
    async setMode(sessionID, mode) {
      const state = await ensure(sessionID);
      if (mode === 'manual') {
        turnOff(state, 'routing off');
        // The session model is persisted, so off has to put the native model back.
        if (state.nativeModel && !sameModel(state.nextModel, state.nativeModel))
          await switchTo(state, state.nativeModel).catch((error) => {
            state.error = error instanceof Error ? error.message : String(error);
          });
      } else Object.assign(state, { mode, phase: 'ready', reason: 'ready', error: null });
      await update(state);
      return sessionSnapshot(state);
    },
    async setPin(sessionID, tier) {
      if (tier !== null && !TIERS.includes(tier)) throw new Error(`unknown tier "${tier}"`);
      const state = await ensure(sessionID);
      if (tier !== null && state.mode === 'manual')
        throw new Error('Routing is off. Turn routing on before pinning a turn.');
      state.pendingPin = tier;
      await update(state);
      return sessionSnapshot(state);
    },
    async setRoute(sessionID, tier, value) {
      if (!TIERS.includes(tier)) throw new Error(`unknown tier "${tier}"`);
      const ref = parseModelRef(value);
      const choices = modelOptions(await listModels());
      if (!choices.some((choice) => choice.ref === value)) throw new Error(`model is not available: ${value}`);
      await changeProfile((saved) => ({ ...saved, routes: { ...saved.routes, [tier]: formatModelRef(ref) } }));
      return sessionSnapshot(await ensure(sessionID));
    },
    async setActivity(sessionID, mode) {
      if (!['on', 'off'].includes(mode)) throw new Error('activity mode must be "on" or "off"');
      await changeProfile((saved) => ({ ...saved, activityRouting: mode }));
      return sessionSnapshot(await ensure(sessionID));
    },
    async setRoutingMode(sessionID, mode) {
      if (mode !== 'default' && !ROUTING_MODES.includes(mode))
        throw new Error(`mode must be one of ${ROUTING_MODES.join(', ')} or default`);
      const state = await ensure(sessionID);
      state.modeOverride = mode === 'default' ? null : mode;
      await update(state);
      return sessionSnapshot(state);
    },
    async setClassifier(sessionID, id) {
      await changeProfile((saved) => ({ ...saved, classifier: id }));
      return sessionSnapshot(await ensure(sessionID));
    },
    async setTimeout(sessionID, timeoutMs) {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('a timeout must be a positive number of ms');
      await changeProfile((saved) => ({
        ...saved,
        classifierTimeouts: { ...saved.classifierTimeouts, [config.classifier]: timeoutMs },
      }));
      return sessionSnapshot(await ensure(sessionID));
    },
    async usage(sessionID, period) {
      if (!PERIODS.includes(period)) throw new Error(`period must be one of ${PERIODS.join(', ')}`);
      const state = await ensure(sessionID);
      const resetAt = await historyResetAt();
      // Other sessions come from storage; this one from memory, which is ahead of what it saved.
      const others = period === 'session' ? [] : (await allUsageKeys()).filter(({ key }) => !key.endsWith(sessionID));
      const merged = mergeUsage([...others.map((entry) => entry.value), state.usage], resetAt);
      const record = withReplies(merged, state.turnEntries);
      return {
        ...usageReport(record, period, Date.now()),
        agreement: state.stats.agreement,
        latency: latencyP95(state.adviceBuckets),
      };
    },
    // Every saved record goes, and a session still holding one in memory cannot write it back over the reset time.
    async deleteHistory(sessionID) {
      await ctx.storage.set(HISTORY_RESET_KEY, Date.now());
      await Promise.all((await allUsageKeys()).map((entry) => ctx.storage.remove(entry.key)));
      for (const state of sessions.values())
        Object.assign(state, {
          usage: emptyUsage(),
          turnEntries: [],
          stats: emptySession(),
          adviceBuckets: Array(LATENCY_BOUNDS.length + 1).fill(0),
        });
      return { sessionID };
    },
    async reset(sessionID) {
      await changeProfile(() => ({}));
      return sessionSnapshot(await ensure(sessionID));
    },
    async undo(sessionID) {
      if (previousProfile === null) throw new Error('Nothing to undo.');
      const before = previousProfile;
      previousProfile = null;
      await saveProfile(before);
      return sessionSnapshot(await ensure(sessionID));
    },
    prompt: failOpen(async (event) => {
      const state = await ensure(event.sessionID);
      state.owned = true;
      const session = await ctx.session.get({ sessionID: event.sessionID });
      // A prompt into a running turn is not a turn: it keeps the route, the pin and any review. A queued prompt starts
      // later with no hook of its own, so a review routes it.
      if ((session.time?.busy ?? 0) > (session.time?.idle ?? 0)) return;
      cancelReview(event.sessionID);
      state.generation += 1;
      const generation = state.generation;
      state.lastPrompt = event.prompt.text;
      // The TUI commits a model the user selected just before this hook, so a difference here is theirs. Comparing
      // here, not on `session.model.selected`, stops a late event letting this turn overwrite their choice.
      const selected = session.model ?? state.nextModel;
      const changed = selected && state.nextModel && !sameModel(selected, state.nextModel);
      const manual = changed && !state.switching && !state.parentID && session.agent === state.agent;
      if (!state.switching) state.nextModel = selected;
      state.agent = session.agent ?? state.agent;
      if (manual && state.mode === 'auto') turnOff(state, 'model selected manually');
      if (state.mode === 'manual' && !state.parentID) state.nativeModel = state.nextModel ?? state.nativeModel;
      turnConfigs.delete(state.sessionID);
      await loadProfile();
      state.fixed = config.fixedAgents.includes(state.agent) || Boolean((await agentDefinition(state.agent))?.model);
      // A subagent keeps the model it spawned on: a switch between its steps would rewrite its context cold.
      if (state.mode === 'manual' || state.parentID || state.fixed) {
        if (state.mode !== 'manual') {
          state.reason = state.parentID ? 'subagent' : `fixed agent ${state.agent}`;
          Object.assign(state, NO_ROUTE);
        }
        await update(state);
        return;
      }
      state.reason = null;
      state.error = null;
      const pin = state.pendingPin;
      if (!pin) {
        state.phase = 'choosing';
        await update(state);
      }
      try {
        const turn = await read(state, {
          prompt: event.prompt.text,
          turnId: event.messageID,
          promptImages: promptHasImages(event.prompt.files),
        });
        const askedAt = Date.now();
        const result = pin ? { advice: null, error: null } : await ask(state, turn.cfg, turn.facts);
        if (!pin) timeAdvice(state, askedAt);
        const answer = acceptActivity(turn.cfg, result.advice);
        state.lastAnswer = answer ? { activity: answer } : null;
        if (state.generation !== generation || state.mode !== 'auto') return;
        state.error = result.error;
        await commit(state, choose(state, turn, { advice: result.advice, pin }), 'prompt', result.advice);
      } catch (error) {
        if (state.generation !== generation) return;
        state.phase = 'routed';
        state.reason = 'no-advice';
        state.error = error instanceof Error ? error.message : String(error);
        await update(state);
      }
    }),
    context: failOpen(async (event) => {
      const state = await ensure(event.sessionID);
      state.owned = true;
      state.agent = event.agent;
      state.activeModel = event.model;
      if (!state.nextModel) state.nextModel = event.model;
      if (state.mode !== 'manual') state.phase = 'routed';
      const routed = state.mode === 'auto' && !state.parentID && !state.fixed;
      if (routed && state.loop?.decision) await routeStep(state, event.model);
      else await read(state);
      await update(state);
    }),
    // Runs before the child session exists, so the model applies from its first request, with no cache to lose. The
    // host resolves `input.model` ahead of the agent's own model and the parent's. A rejection here fails the call.
    spawn: failOpen(async (event) => {
      if (event.tool !== 'subagent' || typeof event.input !== 'object' || event.input === null) return;
      const parent = await ensure(event.sessionID);
      const turn = await turnConfig(parent);
      if (parent.mode !== 'auto' || turn.cfg.subagentRouting === 'off') return;
      const { input } = event;
      const task = { ...input, model: input.model || null, subagentType: input.agent };
      const definition = await agentDefinition(input.agent);
      const pass = input.sessionID ? 'resumed' : passReason(turn.cfg, task, definition);
      const decision = pass ? null : await decideSpawn(parent, turn, task);
      if (decision?.model) event.input = { ...input, model: decision.model };
      const advice = decision?.advice;
      const row = {
        tier: advice?.choice ?? null,
        confidence: advice?.confidence ?? null,
        activity: advice?.activity?.choice ?? null,
        reason: pass ? (PASS_LABEL[pass] ?? pass) : advice ? 'spawn' : 'no-advice',
      };
      const picked = decision?.model || input.model || definition?.model;
      record(parent, 'spawn', row, picked ? parseModelRef(picked) : null);
      await update(parent);
    }),
    idle: failOpen(async (sessionID) => {
      // Events reach every project's controller, but hooks only the session's own. Another project's copy must not
      // write over the session's saved state or count its replies again.
      const state = sessions.get(sessionID);
      if (!state?.owned) return;
      cancelReview(sessionID);
      if (state.phase === 'choosing') Object.assign(state, { phase: 'ready', reason: 'interrupted' });
      const { stored, messages } = await read(state);
      const assistant = stored.findLast((message) => message.type === 'assistant' && message.model);
      if (assistant) state.activeModel = assistant.model;
      await finishTurn(state, messages);
      await update(state);
    }),
    // Compaction or a rewind replaced the history: the votes and cached prefixes were about the old one.
    resetHistory: failOpen(async (sessionID) => {
      const state = sessions.get(sessionID);
      if (!state?.owned || !state.loop) return;
      cancelReview(sessionID);
      state.loop = resetHistory(state.loop);
      await update(state);
    }),
    remove(sessionID) {
      cancelReview(sessionID);
      sessions.delete(sessionID);
      turnConfigs.delete(sessionID);
      // The usage record stays: a period counts what a deleted session spent.
      return ctx.storage.remove(sessionKey(sessionID)).catch(() => {});
    },
    close() {
      controller.abort();
      sessions.clear();
      turnConfigs.clear();
    },
  };
}
