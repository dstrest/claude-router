import { ClassifierClient } from '../lib/classifier-client.mjs';
import { resolveCredentials } from '../lib/classifier-contract.mjs';
import { activeClassifier, TIERS } from '../lib/config.mjs';
import { classifierStatus, classifierWarns } from '../lib/display.mjs';
import { initialState as initialPolicy } from '../lib/policy.mjs';
import {
  classifierConfig,
  classifierLabel,
  decideRoute,
  formatModelRef,
  modelOptions,
  normalizeOptions,
  parseModelRef,
  sameModel,
} from './config.mjs';

const clip = (text, limit) => {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit / 2)}\n…\n${value.slice(-limit / 2)}`;
};

// Stored messages (`session.context()`) give a user turn as `text`; provider messages (`context.messages`) use parts.
function messageText(message) {
  const role = message?.type ?? message?.role;
  if (!['user', 'assistant'].includes(role)) return null;
  if (typeof message.text === 'string') return { role, text: message.text };
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
  return { role, text };
}

function dialogue(messages, prompt, config) {
  const turns = messages
    .map(messageText)
    .filter((message) => message?.text)
    .map((message) => ({ ...message, text: clip(message.text, config.context.maxTextChars) }));
  const last = turns.at(-1);
  if (last?.role === 'user' && last.text === clip(prompt, config.context.maxTextChars)) turns.pop();
  return turns.slice(-config.context.recentTurns);
}

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
  pinned: false,
  requests: 0,
  switchedAtRequest: 0,
  switches: 0,
  policy: initialPolicy(),
  generation: 0,
  sequence: 0,
  updatedAt: Date.now(),
  decisions: [],
});

export async function createController(ctx, options = {}, dependencies = {}) {
  const config = normalizeOptions(options);
  const sessions = new Map();
  const reviews = new Map();
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

  async function ensure(sessionID) {
    if (!sessions.has(sessionID)) {
      const session = await ctx.session.get({ sessionID });
      const state = initialState(session);
      state.classifier = { id: config.classifier, label: classifierLabel(config) };
      sessions.set(sessionID, state);
    }
    return sessions.get(sessionID);
  }

  async function update(state) {
    state.sequence += 1;
    state.updatedAt = Date.now();
    await publish(sessionSnapshot(state));
  }

  function sessionSnapshot(state) {
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

  async function ask(sessionID, prompt, messages, abort = controller.signal) {
    const state = await ensure(sessionID);
    const cfg = classifierConfig(config, state.activeModel);
    const credentials = await resolveCredentials(activeClassifier(cfg), async (name) => {
      const env = name.toUpperCase();
      return ctx.options[name] || process.env[env] || (name === 'openrouter_api_key' ? openRouterKey() : null);
    });
    const signal = AbortSignal.any([controller.signal, abort]);
    const turns = dialogue(messages, prompt, config);
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
          prompt: clip(prompt, config.context.maxTextChars),
          turns,
          signal,
        });
    return { advice: result.advice, error: classifierProblem(cfg, result.error) };
  }

  function record(state, origin, decision) {
    state.decisions.unshift({
      at: Date.now(),
      origin,
      classifier: state.classifier.label,
      tier: decision.tier ?? null,
      confidence: decision.tierConfidence ?? null,
      activity: decision.activity ?? null,
      reason: decision.reason,
      model: formatModelRef(decision.nextModel),
    });
    state.decisions.length = Math.min(state.decisions.length, 20);
  }

  async function applyDecision(state, origin, result, pin = null) {
    const models = await listModels();
    const decision = decideRoute({
      config,
      currentModel: state.activeModel,
      previousTier: state.tier,
      pin,
      advice: result.advice,
      error: result.error,
      models,
      policyState: state.policy,
      facts: {
        midTurn: origin === 'review',
        historyMeasured: state.requests > 0,
        // shortcut: dwell only, without the Claude adapter's checkpoint test; upgrade when OpenCode tool results are parsed.
        downAllowed: state.requests - state.switchedAtRequest >= config.policy.minDwellRequests,
      },
    });
    Object.assign(state, decision, { phase: state.mode === 'manual' ? 'manual' : 'routed' });
    if (pin) state.pendingPin = null;
    record(state, origin, decision);
    if (!sameModel(state.activeModel, state.nextModel)) {
      try {
        await ctx.session.switchModel({ sessionID: state.sessionID, model: state.nextModel });
        state.switchedAtRequest = state.requests;
        state.switches += 1;
      } catch (error) {
        state.nextModel = state.activeModel;
        state.reason = 'model switch failed';
        state.error = error instanceof Error ? error.message : String(error);
      }
    }
    await update(state);
  }

  async function review(state, messages) {
    const abort = new AbortController();
    reviews.set(state.sessionID, abort);
    try {
      const result = await ask(state.sessionID, state.lastPrompt ?? '', messages, abort.signal);
      // A failed review is a no-op: the route, the reason and any pin stay as they were.
      if (abort.signal.aborted || controller.signal.aborted || state.mode !== 'auto' || !result.advice) return;
      await applyDecision(state, 'review', result);
    } catch (error) {
      console.error('OpenCode router review failed', error);
    } finally {
      if (reviews.get(state.sessionID) === abort) reviews.delete(state.sessionID);
    }
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
      state.nextModel = state.activeModel;
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
      state.reason = `${tier} route updated for the next decision`;
      await update(state);
      return sessionSnapshot(state);
    },
    async setActivity(sessionID, mode) {
      if (!['on', 'off'].includes(mode)) throw new Error('activity mode must be "on" or "off"');
      config.activityRouting = mode;
      const state = await ensure(sessionID);
      state.reason = `activity routing ${mode}`;
      await update(state);
      return sessionSnapshot(state);
    },
    prompt: failOpen(async (event) => {
      const state = await ensure(event.sessionID);
      cancelReview(event.sessionID);
      state.generation += 1;
      const generation = state.generation;
      state.lastPrompt = event.prompt.text;
      state.agent = (await ctx.session.get({ sessionID: event.sessionID })).agent ?? state.agent;
      if (state.mode === 'manual' || config.fixedAgents.includes(state.agent)) {
        state.nextModel = state.activeModel;
        if (state.mode !== 'manual') state.reason = `fixed agent ${state.agent}`;
        await update(state);
        return;
      }
      state.reason = null;
      state.error = null;
      const pin = state.pendingPin;
      state.pinned = Boolean(pin);
      if (!pin) {
        state.phase = 'choosing';
        await update(state);
      }
      try {
        const messages = pin ? [] : await ctx.session.context({ sessionID: state.sessionID });
        const result = pin ? { advice: null, error: null } : await ask(state.sessionID, event.prompt.text, messages);
        if (state.generation !== generation || state.mode !== 'auto') return;
        await applyDecision(state, 'prompt', result, pin);
      } catch (error) {
        if (state.generation !== generation) return;
        state.phase = 'routed';
        state.nextModel = state.activeModel;
        state.reason = 'classifier failed; keeping active model';
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
      state.requests += 1;
      await update(state);
      const every = config.policy.reviewEveryRequests;
      const routed =
        state.mode === 'auto' && !state.pinned && !state.parentID && !config.fixedAgents.includes(event.agent);
      if (routed && every > 0 && state.requests % every === 0 && !reviews.has(state.sessionID))
        void review(state, event.messages);
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
    },
    close() {
      controller.abort();
      sessions.clear();
    },
  };
}
