import { ClassifierClient } from '../lib/classifier-client.mjs';
import { resolveCredentials } from '../lib/classifier-contract.mjs';
import { activeClassifier, TIERS } from '../lib/config.mjs';
import { classifierStatus, classifierWarns } from '../lib/display.mjs';
import { observedActivity, promptIndex, routingBucket } from '../lib/facts.mjs';
import {
  canMoveUp,
  chooseRoute,
  continueRoute,
  emptyLoop,
  isNativeFallback,
  nativeFacts,
  observedMove,
  observeResponse,
  prepareLoop,
} from '../lib/route.mjs';
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

const initialState = (session) => ({
  sessionID: session.id,
  parentID: session.parentID ?? null,
  agent: session.agent ?? null,
  mode: 'auto',
  phase: 'ready',
  classifier: { id: null, label: null },
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
  loop: null,
  observedAt: null,
  generation: 0,
  sequence: 0,
  updatedAt: Date.now(),
  decisions: [],
});

export async function createController(ctx, options = {}, dependencies = {}) {
  const config = normalizeOptions(options);
  const sessions = new Map();
  const reviews = new Map();
  const loading = new Map();
  const turnConfigs = new Map();
  // Shared so one session's failures pause the classifier for all, and not exclusive so sessions do not answer each other `busy`.
  const client = new ClassifierClient({ exclusive: false });
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

  function ensure(sessionID) {
    if (sessions.has(sessionID)) return sessions.get(sessionID);
    // One read per session: a TUI snapshot can race the prompt hook, and each decision must land on the same state.
    if (!loading.has(sessionID))
      loading.set(
        sessionID,
        ctx.session
          .get({ sessionID })
          .then((session) => {
            const state = initialState(session);
            state.classifier = { id: config.classifier, label: classifierLabel(config) };
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
    await publish(sessionSnapshot(state));
  }

  function sessionSnapshot({ loop: _loop, ...state }) {
    return {
      ...structuredClone(state),
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

  async function ask(state, cfg, facts, abort = controller.signal) {
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
      : await client.ask({
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
      classifier: state.classifier.label,
      tier: decision.tier ?? null,
      confidence: state.tierConfidence,
      activity: decision.activity ?? null,
      reason: decision.reason,
      model: formatModelRef(ref ?? state.nextModel),
    });
    state.decisions.length = Math.min(state.decisions.length, 20);
  }

  // The config stays frozen for a turn: a route edit reaches the next turn, not a step of this one.
  async function turnConfig(state) {
    if (!turnConfigs.has(state.sessionID)) {
      const catalog = await listModels();
      turnConfigs.set(state.sessionID, {
        cfg: routerConfig(config, catalog, state.nativeModel),
        availableModels: availableModelIds(catalog),
        nativeModel: modelId(state.nativeModel),
      });
    }
    return turnConfigs.get(state.sessionID);
  }

  // Replies since the last read. Reading stored messages, not step events, keeps usage in step with the transcript; a
  // session new to this controller counts only its last reply, which is enough to measure the context.
  function observe(cfg, loop, state, stored) {
    const replies = stored.filter(
      (message) => message?.type === 'assistant' && message.tokens && message.time?.completed,
    );
    const unseen = state.observedAt
      ? replies.filter((message) => message.time.completed > state.observedAt)
      : replies.slice(-1);
    state.observedAt = replies.at(-1)?.time.completed ?? state.observedAt;
    return unseen.reduce(
      (next, message) =>
        observeResponse(cfg, next, {
          usage: usageOf(message),
          requestedModel: modelId(message.model),
          effort: variantOf(message.model),
          stopReason: stopReasonOf(message),
          now: message.time.completed,
        }),
      loop,
    );
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
    return { ...turn, facts, messages, empty, contextKnown: Boolean(last) || empty };
  }

  function showDecision(state, decision, advice) {
    Object.assign(state, { tier: decision.tier, activity: decision.activity ?? null, reason: decision.reason });
    if (advice === undefined) return;
    const activity = advice?.activity;
    Object.assign(state, {
      tierConfidence: advice?.confidence ?? null,
      tierProbability: advice?.probabilities?.[decision.tier] ?? null,
      activityChoice: activity?.choice ?? null,
      activityProbability: activity?.probabilities?.[activity.choice] ?? null,
    });
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
        await ctx.session.switchModel({ sessionID: state.sessionID, model: ref });
      } catch (error) {
        state.loop = previous;
        state.reason = 'model-unavailable';
        state.error = error instanceof Error ? error.message : String(error);
        await update(state);
        return;
      }
      state.nextModel = ref;
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
      state.mode = mode;
      state.phase = mode === 'manual' ? 'manual' : 'ready';
      state.reason = mode === 'manual' ? 'routing off' : 'ready';
      state.error = null;
      await update(state);
      return sessionSnapshot(state);
    },
    async setPin(sessionID, tier) {
      if (tier !== null && !TIERS.includes(tier)) throw new Error(`unknown tier "${tier}"`);
      const state = await ensure(sessionID);
      state.pendingPin = tier;
      await update(state);
      return sessionSnapshot(state);
    },
    async setRoute(sessionID, tier, value) {
      if (!TIERS.includes(tier)) throw new Error(`unknown tier "${tier}"`);
      const ref = parseModelRef(value);
      const choices = modelOptions(await listModels());
      if (!choices.some((choice) => choice.ref === value)) throw new Error(`model is not available: ${value}`);
      config.routeRefs[tier] = ref;
      const state = await ensure(sessionID);
      await update(state);
      return sessionSnapshot(state);
    },
    async setActivity(sessionID, mode) {
      if (!['on', 'off'].includes(mode)) throw new Error('activity mode must be "on" or "off"');
      config.activityRouting = mode;
      const state = await ensure(sessionID);
      await update(state);
      return sessionSnapshot(state);
    },
    prompt: failOpen(async (event) => {
      const state = await ensure(event.sessionID);
      cancelReview(event.sessionID);
      state.generation += 1;
      const generation = state.generation;
      state.lastPrompt = event.prompt.text;
      const session = await ctx.session.get({ sessionID: event.sessionID });
      state.agent = session.agent ?? state.agent;
      state.nextModel = session.model ?? state.nextModel;
      if (state.mode === 'manual' || config.fixedAgents.includes(state.agent)) {
        if (state.mode !== 'manual') state.reason = `fixed agent ${state.agent}`;
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
        turnConfigs.delete(state.sessionID);
        const turn = await read(state, {
          prompt: event.prompt.text,
          turnId: event.messageID,
          promptImages: promptHasImages(event.prompt.files),
        });
        const result = pin ? { advice: null, error: null } : await ask(state, turn.cfg, turn.facts);
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
      state.agent = event.agent;
      state.activeModel = event.model;
      if (!state.nextModel) state.nextModel = event.model;
      if (state.mode !== 'manual') state.phase = 'routed';
      const routed = state.mode === 'auto' && !state.parentID && !config.fixedAgents.includes(event.agent);
      if (routed && state.loop?.decision) await routeStep(state, event.model);
      await update(state);
    }),
    idle: failOpen(async (sessionID) => {
      cancelReview(sessionID);
      const state = await ensure(sessionID);
      const messages = await ctx.session.context({ sessionID });
      const assistant = messages.findLast((message) => message.type === 'assistant' && message.model);
      if (assistant) state.activeModel = assistant.model;
      await update(state);
    }),
    remove(sessionID) {
      cancelReview(sessionID);
      sessions.delete(sessionID);
      turnConfigs.delete(sessionID);
    },
    close() {
      controller.abort();
      sessions.clear();
      turnConfigs.clear();
    },
  };
}
