import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TIERS } from '../lib/config.mjs';
import { chooseRoute, emptyLoop, nativeFacts } from '../lib/route.mjs';
import { availableModelIds, formatModelRef, modelId, normalizeOptions, routerConfig } from '../opencode/config.mjs';
import { createController } from '../opencode/controller.mjs';

const kimi = { providerID: 'openrouter', id: 'moonshotai/kimi-k3.1-pro', variant: 'high' };
const openai = { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'high' };
const tiny = { providerID: 'openrouter', id: 'cheap/tiny' };
const priced = (input, output, context) => ({
  cost: [{ input, output, cache: { read: input / 10, write: input * 1.25 } }],
  limit: { context, output: 8000 },
  capabilities: { input: ['text', 'image'] },
});
const models = [
  {
    providerID: kimi.providerID,
    id: kimi.id,
    name: 'Kimi',
    variants: [{ id: 'high' }, { id: 'max' }],
    ...priced(1, 4, 1_000_000),
  },
  {
    providerID: openai.providerID,
    id: openai.id,
    name: 'GPT',
    variants: [{ id: 'high' }],
    ...priced(5, 25, 1_000_000),
  },
  { providerID: tiny.providerID, id: tiny.id, name: 'Tiny', variants: [], ...priced(0.1, 0.4, 100_000) },
];
const fullAdvice = (advice) =>
  advice && {
    ...advice,
    probabilities: { ...Object.fromEntries(TIERS.map((tier) => [tier, 0])), ...advice.probabilities },
  };

const harnessDirectory = mkdtempSync(join(tmpdir(), 'opencode-router-'));
test.after(() => rmSync(harnessDirectory, { recursive: true, force: true }));
function memoryStorage() {
  const entries = new Map();
  return {
    entries,
    get: async (key) => (entries.has(key) ? structuredClone(entries.get(key)) : null),
    set: async (key, value) => void entries.set(key, structuredClone(value)),
    remove: async (key) => void entries.delete(key),
    scan: async ({ prefix }) => ({
      entries: [...entries]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value: structuredClone(value) })),
    }),
  };
}

async function harness(
  initialAdvice,
  routes = { high: 'openai/gpt-6.1-sol#high' },
  fixedAgents = [],
  sessionFields = {},
  dependencies = null,
  activities = {},
  options = {},
  agents = { build: {}, general: {}, web: { model: tiny } },
) {
  const switches = [];
  const published = [];
  const current = { advice: initialAdvice, asks: 0, answer: null, clock: Date.now() };
  const calls = [];
  const stored = [];
  const selected = { model: Object.hasOwn(sessionFields, 'model') ? sessionFields.model : kimi };
  const ctx = {
    options: {},
    session: {
      get: async ({ sessionID }) => ({
        id: sessionID,
        agent: selected.agent ?? 'build',
        ...(sessionID === sessionFields.parentID ? {} : sessionFields),
        model: selected.model,
        time: selected.time,
      }),
      context: async () => stored,
      switchModel: async (input) => {
        switches.push(input);
        selected.model = input.model;
      },
    },
    model: { list: async () => ({ data: models }) },
    location: { directory: harnessDirectory },
    storage: memoryStorage(),
    agent: {
      get: async ({ agentID }) => {
        if (!Object.hasOwn(agents, agentID)) throw new Error('unknown agent');
        return { data: { id: agentID, ...agents[agentID] } };
      },
    },
  };
  const harnessAsk = async (input) => {
    current.asks += 1;
    calls.push(input);
    if (current.answer) return current.answer(input);
    return { advice: fullAdvice(current.advice), error: null };
  };
  const controller = await createController(
    ctx,
    { classifier: 'ollama', routes, activities, fixedAgents, ...options },
    dependencies ?? { ask: harnessAsk },
  );
  controller.setPublisher(async (state) => published.push(state));
  // One provider request that finished: the stored reply lib/route.mjs measures.
  const reply = (fields = {}) => {
    current.clock += 1;
    stored.push({
      type: 'assistant',
      model: selected.model,
      content: [{ type: 'text', text: 'Done' }],
      tokens: { input: 2, output: 10, reasoning: 0, cache: { read: 1000, write: 10 } },
      finish: 'stop',
      cost: 0,
      time: { created: current.clock, completed: current.clock },
      ...fields,
    });
  };
  // The next provider request starts, then finishes.
  const step = async (model = selected.model, agent = 'build') => {
    await controller.context({ sessionID: 'ses_test', agent, model, messages: [] });
    await settle();
    reply();
  };
  return {
    ctx,
    controller,
    // A service restart: a new controller over the same durable storage.
    restart: () =>
      createController(
        ctx,
        { classifier: 'ollama', routes, activities, fixedAgents, ...options },
        dependencies ?? { ask: harnessAsk },
      ),
    switches,
    published,
    calls,
    stored,
    reply,
    step,
    steps: async (count) => {
      for (let request = 0; request < count; request += 1) await step();
    },
    asks: () => current.asks,
    // What the TUI's commit on submit does: the session's selection changes before the prompt hook runs.
    setRunning: (running) => {
      selected.time = running ? { busy: 2, idle: 1 } : { busy: 1, idle: 2 };
    },
    selectModel: (model, agent) => {
      selected.model = model;
      if (agent) selected.agent = agent;
    },
    setAnswer: (answer) => {
      current.answer = answer;
    },
    setAdvice: (next) => {
      current.advice = next;
    },
  };
}

const settle = async () => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};
const quietConsole = (t) => t.mock.method(console, 'error', () => {});
const send = (controller, text = 'Work', sessionID = 'ses_test', extra = {}) =>
  controller.prompt({ sessionID, prompt: { text }, ...extra });
const highAdvice = { choice: 'high', confidence: 0.9, probabilities: { high: 0.9 } };
const lowAdvice = { choice: 'low', confidence: 0.9, probabilities: { low: 0.9 } };
const planAdvice = (activityMass) => ({
  choice: 'uncertain',
  confidence: 0.2,
  probabilities: { low: 0.3, medium: 0.3, high: 0.2 },
  activity: { choice: 'plan', probabilities: { plan: activityMass } },
});

test('prompt routing switches to the selected provider and records visible advice', async () => {
  const { controller, switches, published } = await harness({
    choice: 'high',
    confidence: 0.88,
    probabilities: { high: 0.93 },
    activity: { choice: 'debug', probabilities: { debug: 0.81 } },
  });
  await send(controller, 'Find the race condition');
  const state = await controller.snapshot('ses_test');
  assert.deepEqual(switches, [{ sessionID: 'ses_test', model: openai }]);
  assert.equal(state.tier, 'high');
  assert.equal(state.tierConfidence, 0.88);
  assert.equal(state.tierProbability, 0.93);
  assert.equal(state.activity, 'debug');
  assert.equal(state.activityProbability, 0.81);
  assert.deepEqual(state.activeModel, kimi);
  assert.deepEqual(state.nextModel, openai);
  assert.equal(published.at(-1).decisions[0].origin, 'prompt');
  assert.equal(published.at(-1).loop, undefined);
  controller.close();
});

test('the context hook reveals the model serving active work', async () => {
  const { controller, step } = await harness(highAdvice);
  await send(controller);
  await step(openai);
  const state = await controller.snapshot('ses_test');
  assert.deepEqual(state.activeModel, openai);
  assert.deepEqual(state.nextModel, openai);
  controller.close();
});

test('manual mode never asks the classifier or switches the model', async () => {
  const { controller, switches, published } = await harness(highAdvice);
  await controller.setMode('ses_test', 'manual');
  await send(controller);
  assert.equal(
    published.some((state) => state.phase === 'choosing'),
    false,
  );
  assert.equal(switches.length, 0);
  assert.equal((await controller.snapshot('ses_test')).mode, 'manual');
  controller.close();
});

test('route controls accept an available model from any provider and reject unknown tiers', async () => {
  const { controller, asks } = await harness(null);
  await controller.setRoute('ses_test', 'medium', 'openrouter/moonshotai/kimi-k3.1-pro#max');
  await controller.setPin('ses_test', 'medium');
  await send(controller, 'Review this');
  const state = await controller.snapshot('ses_test');
  assert.equal(state.nextModel.variant, 'max');
  assert.equal(state.reason, 'pinned');
  assert.equal(asks(), 0);
  await assert.rejects(() => controller.setRoute('ses_test', 'extreme', 'openai/gpt-6.1-sol#high'), /unknown tier/);
  controller.close();
});

test('a review applies a stronger route to the next step of the running turn', async () => {
  const { controller, switches, setAdvice, steps } = await harness(lowAdvice, {
    low: 'openrouter/moonshotai/kimi-k3.1-pro#high',
    high: 'openai/gpt-6.1-sol#high',
  });
  await send(controller);
  setAdvice({ choice: 'high', confidence: 0.98, probabilities: { high: 0.98, low: 0.02 } });
  await steps(9);
  assert.deepEqual(switches, [{ sessionID: 'ses_test', model: openai }]);
  const state = await controller.snapshot('ses_test');
  assert.equal(state.decisions[0].origin, 'review');
  assert.equal(state.tier, 'high');
  controller.close();
});

test('reviews wait for four requests since the last answer, however the count is reached', async () => {
  const { controller, asks, steps, reply } = await harness(lowAdvice);
  await send(controller);
  assert.equal(asks(), 1);
  await steps(4);
  assert.equal(asks(), 1);
  // Three requests landed between hooks, so the count skips past a multiple of four.
  reply();
  reply();
  await steps(1);
  assert.equal(asks(), 2);
  controller.close();
});

test('one noisy prompt does not move the model until a second vote agrees', async () => {
  const { controller, switches, setAdvice, step } = await harness(lowAdvice, {
    low: 'openrouter/moonshotai/kimi-k3.1-pro#high',
    high: 'openai/gpt-6.1-sol#high',
  });
  await send(controller);
  await step();
  setAdvice({ choice: 'high', confidence: 0.8, probabilities: { high: 0.8, low: 0.2 } });
  await send(controller);
  await step();
  assert.equal(switches.length, 0);
  assert.equal((await controller.snapshot('ses_test')).reason, 'upgrade-pending');
  await send(controller);
  assert.deepEqual(switches, [{ sessionID: 'ses_test', model: openai }]);
  assert.equal((await controller.snapshot('ses_test')).reason, 'upgrade');
  controller.close();
});

test('a confident two-tier jump moves on a single vote', async () => {
  const { controller, switches, setAdvice, step } = await harness(
    { choice: 'micro', confidence: 0.9, probabilities: { micro: 0.9 } },
    {
      micro: 'openrouter/moonshotai/kimi-k3.1-pro#high',
      high: 'openai/gpt-6.1-sol#high',
    },
  );
  await send(controller, 'Hi');
  await step();
  setAdvice({ choice: 'high', confidence: 0.99, probabilities: { high: 0.99, micro: 0.01 } });
  await send(controller, 'Redesign it all');
  assert.deepEqual(switches, [{ sessionID: 'ses_test', model: openai }]);
  assert.equal((await controller.snapshot('ses_test')).reason, 'jump');
  controller.close();
});

test('a fixed agent keeps its own model and never asks the classifier', async () => {
  const { controller, switches, asks } = await harness(highAdvice);
  await send(controller, 'Plan');
  assert.equal(asks(), 1);
  const fixed = await harness(highAdvice, undefined, ['build']);
  await send(fixed.controller, 'Plan');
  assert.equal(fixed.asks(), 0);
  assert.equal(fixed.switches.length, 0);
  assert.equal((await fixed.controller.snapshot('ses_test')).reason, 'fixed agent build');
  assert.equal(switches.length, 1);
  controller.close();
  fixed.controller.close();
});

test('Jev through OpenRouter posts System One with the stored OpenRouter key', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    const route = { type: 'choice', choice: 'high', confidence: 0.9, probabilities: { high: 0.9, medium: 0.1 } };
    return new Response(JSON.stringify({ answers: { route } }));
  });
  const ctx = {
    options: {},
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, model: kimi, agent: 'build' }),
      context: async () => [],
      switchModel: async () => {},
    },
    model: { list: async () => ({ data: models }) },
    location: { directory: harnessDirectory },
    storage: memoryStorage(),
    integration: {
      connection: {
        active: async (id) => ({ id }),
        resolve: async ({ id }) => (id === 'openrouter' ? { type: 'api', key: 'stored-key' } : undefined),
      },
    },
  };
  const controller = await createController(ctx, {
    classifier: 'jev-openrouter',
    routes: { high: 'openai/gpt-6.1-sol#high' },
  });
  await controller.prompt({ sessionID: 'ses_test', prompt: { text: 'Work' } });
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/systemone');
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer stored-key');
  assert.equal(JSON.parse(calls[0].init.body).model, 'typesafe/jev-1.14');
  assert.equal((await controller.snapshot('ses_test')).tier, 'high');
  controller.close();
});

test('the switch count rises only when the model really changed', async () => {
  const { controller, published, step } = await harness(highAdvice);
  await send(controller);
  assert.equal(published.at(-1).switches, 1);
  await step();
  await send(controller, 'More work');
  assert.equal(published.at(-1).switches, 1);
  controller.close();
});

test('a failed model switch changes no route, row or count', async () => {
  const { controller, ctx, published } = await harness(highAdvice);
  ctx.session.switchModel = async () => {
    throw new Error('rejected');
  };
  await send(controller);
  const state = published.at(-1);
  assert.equal(state.switches, 0);
  assert.equal(state.reason, 'model-unavailable');
  assert.equal(state.error, 'rejected');
  assert.equal(state.tier, null);
  assert.equal(state.decisions.length, 0);
  assert.deepEqual(state.nextModel, kimi);
  controller.close();
});

test('the classifier reads the dialogue in stored session messages', async () => {
  const { controller, stored, calls, reply } = await harness(highAdvice);
  stored.push({ type: 'user', text: '<system-reminder>noise</system-reminder>Earlier question' });
  stored.push({ type: 'model-switched', model: kimi });
  reply({ content: [{ type: 'text', text: 'Earlier answer' }, { type: 'tool' }] });
  stored.push({ type: 'idle', outcome: 'succeeded' });
  await send(controller);
  assert.equal(calls[0].prompt, 'Work');
  assert.deepEqual(calls[0].turns, [
    { role: 'user', text: 'Earlier question' },
    { role: 'assistant', text: 'Earlier answer' },
  ]);
  controller.close();
});

test('a long prompt is clipped to the limit', async () => {
  const { controller, calls } = await harness(highAdvice);
  await send(controller, 'x'.repeat(1_000_000));
  assert.ok(calls[0].prompt.length <= normalizeOptions().context.maxTextChars);
  controller.close();
});

test('a prompt during a review cancels it, and later reviews still run', async () => {
  const { controller, calls, setAnswer, steps } = await harness(highAdvice);
  await send(controller);
  setAnswer(() => new Promise(() => {}));
  await steps(5);
  assert.equal(calls.length, 2);
  const inFlight = calls[1];
  assert.equal(inFlight.signal.aborted, false);
  setAnswer(null);
  await send(controller, 'Next');
  assert.equal(inFlight.signal.aborted, true);
  await steps(5);
  assert.equal(calls.length, 4);
  controller.close();
});

test('a review is cancelled when the turn ends', async () => {
  const { controller, calls, setAnswer, steps } = await harness(highAdvice);
  await send(controller);
  setAnswer(() => new Promise(() => {}));
  await steps(5);
  await controller.idle('ses_test');
  assert.equal(calls[1].signal.aborted, true);
  controller.close();
});

test('a failed review changes nothing, including a pin set while it ran', async () => {
  const { controller, setAnswer, published, steps } = await harness(highAdvice);
  await send(controller);
  const before = await controller.snapshot('ses_test');
  setAnswer(async () => {
    await controller.setPin('ses_test', 'low');
    return { advice: null, error: 'timeout' };
  });
  await steps(5);
  const after = await controller.snapshot('ses_test');
  assert.equal(after.pendingPin, 'low');
  assert.equal(after.reason, before.reason);
  assert.equal(after.error, null);
  assert.equal(after.decisions.length, before.decisions.length);
  assert.equal(published.at(-1).pendingPin, 'low');
  controller.close();
});

test('a review that throws changes nothing', async (t) => {
  const log = quietConsole(t);
  const { controller, setAnswer, steps } = await harness(highAdvice);
  await send(controller);
  const before = await controller.snapshot('ses_test');
  setAnswer(async () => {
    throw new Error('boom');
  });
  await steps(5);
  const after = await controller.snapshot('ses_test');
  assert.equal(after.reason, before.reason);
  assert.equal(after.error, null);
  assert.equal(log.mock.callCount(), 1);
  controller.close();
});

test('a successful review keeps a pin set while it ran', async () => {
  const { controller, setAnswer, steps } = await harness(highAdvice);
  await send(controller);
  setAnswer(async () => {
    await controller.setPin('ses_test', 'low');
    return { advice: fullAdvice(highAdvice), error: null };
  });
  await steps(5);
  assert.equal((await controller.snapshot('ses_test')).pendingPin, 'low');
  controller.close();
});

test('a pinned turn is not reviewed, and the next turn is', async () => {
  const { controller, asks, steps } = await harness(highAdvice);
  await controller.setPin('ses_test', 'high');
  await send(controller);
  await steps(9);
  assert.equal(asks(), 0);
  await send(controller, 'More');
  await steps(5);
  assert.equal(asks(), 2);
  controller.close();
});

test('a pin does not become the incumbent for the next turn', async () => {
  const routes = { low: 'openrouter/moonshotai/kimi-k3.1-pro#high', high: 'openai/gpt-6.1-sol#high' };
  const { controller, switches, step } = await harness(lowAdvice, routes);
  await send(controller);
  await step();
  await controller.setPin('ses_test', 'high');
  await send(controller, 'Pinned');
  assert.deepEqual(switches.at(-1).model, openai);
  await step();
  await send(controller, 'Back');
  assert.deepEqual(switches.at(-1).model, kimi);
  assert.equal((await controller.snapshot('ses_test')).tier, 'low');
  controller.close();
});

test('a subagent session is never reviewed during its run', async () => {
  const { controller, asks, steps } = await harness(highAdvice, undefined, [], { parentID: 'ses_parent' });
  await send(controller);
  const atSpawn = asks();
  await steps(9);
  assert.equal(asks(), atSpawn);
  controller.close();
});

test('a session without a model and with partial routes still reaches the classifier', async () => {
  const { controller, asks, switches } = await harness(highAdvice, { high: 'openai/gpt-6.1-sol#high' }, [], {
    model: undefined,
  });
  await send(controller);
  assert.equal(asks(), 1);
  assert.deepEqual(switches, [{ sessionID: 'ses_test', model: openai }]);
  controller.close();
});

test('a tier without a route runs the session model, and with no session model it falls back', async () => {
  const native = await harness(lowAdvice);
  await send(native.controller);
  assert.equal(native.switches.length, 0);
  assert.equal((await native.controller.snapshot('ses_test')).tier, 'low');
  native.controller.close();
  const unset = await harness(lowAdvice, {}, [], { model: undefined });
  await send(unset.controller);
  assert.equal(unset.switches.length, 0);
  assert.equal((await unset.controller.snapshot('ses_test')).reason, 'model-unavailable');
  unset.controller.close();
});

test('routine classifier states stay silent and real failures use the display wording', async () => {
  const { controller, setAnswer } = await harness(highAdvice);
  for (const error of ['busy', 'cancelled']) {
    setAnswer(() => ({ advice: null, error }));
    await send(controller);
    assert.equal((await controller.snapshot('ses_test')).error, null, error);
  }
  setAnswer(() => ({ advice: null, error: 'timeout' }));
  await send(controller);
  const state = await controller.snapshot('ses_test');
  assert.equal(state.error, 'Ollama timed out');
  assert.equal(state.reason, 'no-advice');
  controller.close();
});

test('the failure breaker is shared across sessions and names when it reopens', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('nope', { status: 400 }));
  const { controller } = await harness(highAdvice, undefined, [], {}, {});
  for (let failure = 0; failure < 3; failure += 1) await send(controller, 'Work', 'ses_first');
  const sent = fetch.mock.callCount();
  await send(controller, 'Work', 'ses_second');
  assert.equal(fetch.mock.callCount(), sent);
  assert.match((await controller.snapshot('ses_second')).error, /^Ollama paused after failures until .+\d/);
  controller.close();
});

test('a host failure never rejects a hook, which would lose the prompt, or ends the event loop', async (t) => {
  const log = quietConsole(t);
  const { controller, ctx } = await harness(highAdvice);
  ctx.session.get = async () => {
    throw new Error('host down');
  };
  await send(controller);
  await controller.context({ sessionID: 'ses_test', agent: 'build', model: kimi, messages: [] });
  await controller.idle('ses_test');
  assert.equal(log.mock.callCount(), 3);
  controller.close();
});

test('a failed publish does not reject a hook', async (t) => {
  quietConsole(t);
  const { controller } = await harness(highAdvice);
  controller.setPublisher(async () => {
    throw new Error('rpc closed');
  });
  await send(controller);
  await controller.context({ sessionID: 'ses_test', agent: 'build', model: kimi, messages: [] });
  controller.close();
});

test('a snapshot racing the first prompt shares its state', async () => {
  const { controller } = await harness(highAdvice);
  const [, state] = await Promise.all([send(controller), controller.snapshot('ses_test')]);
  assert.equal(state.sessionID, 'ses_test');
  assert.equal((await controller.snapshot('ses_test')).tier, 'high');
  controller.close();
});

const planRoutes = { low: 'openrouter/moonshotai/kimi-k3.1-pro#high', high: 'openai/gpt-6.1-sol#high' };
const planActivities = { plan: { low: 'openai/gpt-6.1-sol#high' } };

test('a confident activity routes an uncertain tier, as chooseRoute does', async () => {
  const { controller, switches } = await harness(planAdvice(0.95), planRoutes, [], {}, null, planActivities);
  await send(controller);
  const state = await controller.snapshot('ses_test');
  assert.equal(state.activity, 'plan');
  assert.equal(state.reason, 'activity-up');
  assert.deepEqual(switches, [{ sessionID: 'ses_test', model: openai }]);
  controller.close();
});

test('an activity below the bar keeps the base route', async () => {
  const { controller, switches } = await harness(planAdvice(0.4), planRoutes, [], {}, null, planActivities);
  await send(controller);
  assert.equal(switches.length, 0);
  assert.equal((await controller.snapshot('ses_test')).activity, null);
  controller.close();
});

test('a route edit is gated: a cheaper route on the same task waits for its checkpoint', async () => {
  const routes = { low: 'openai/gpt-6.1-sol#high' };
  const advice = { ...lowAdvice, continuation: 0.9 };
  const { controller, switches, step } = await harness(advice, routes, [], { model: openai });
  await send(controller);
  await step();
  await controller.setRoute('ses_test', 'low', 'openrouter/moonshotai/kimi-k3.1-pro#high');
  await send(controller, 'Same task');
  assert.equal(switches.length, 0);
  assert.equal((await controller.snapshot('ses_test')).reason, 'downgrade-held');
  controller.close();
});

test('a session too full for a route stays on the larger window with context-fit', async () => {
  const routes = { low: 'openrouter/cheap/tiny', high: 'openrouter/moonshotai/kimi-k3.1-pro#high' };
  const { controller, switches, reply } = await harness(lowAdvice, routes);
  reply({ tokens: { input: 2, output: 500, reasoning: 0, cache: { read: 300_000, write: 0 } } });
  await send(controller);
  await send(controller, 'Second vote');
  const state = await controller.snapshot('ses_test');
  assert.equal(state.reason, 'context-fit');
  assert.notEqual(state.tier, 'low');
  assert.equal(switches.length, 0);
  controller.close();
});

test('growth during a turn moves it off a window it no longer fits', async () => {
  const routes = { low: 'openrouter/cheap/tiny', high: 'openrouter/moonshotai/kimi-k3.1-pro#high' };
  const { controller, switches, reply, step } = await harness(lowAdvice, routes, [], { model: tiny });
  await send(controller);
  reply({ tokens: { input: 2, output: 500, reasoning: 0, cache: { read: 300_000, write: 0 } } });
  await step();
  assert.deepEqual(switches, [{ sessionID: 'ses_test', model: kimi }]);
  const state = await controller.snapshot('ses_test');
  assert.equal(state.reason, 'context-fit');
  assert.equal(state.decisions[0].origin, 'step');
  controller.close();
});

test('an unmeasured history holds a smaller window, and a new session does not', async () => {
  const routes = { low: 'openrouter/cheap/tiny', high: 'openrouter/moonshotai/kimi-k3.1-pro#high' };
  const fresh = await harness(lowAdvice, routes);
  await send(fresh.controller);
  assert.deepEqual(fresh.switches, [{ sessionID: 'ses_test', model: tiny }]);
  fresh.controller.close();
  const resumed = await harness(lowAdvice, routes);
  resumed.stored.push({ type: 'user', text: 'History with no measured reply' });
  await send(resumed.controller);
  assert.equal(resumed.switches.length, 0);
  assert.equal((await resumed.controller.snapshot('ses_test')).reason, 'context-unknown');
  resumed.controller.close();
});

test('an image skips a route that cannot read it', async () => {
  const blind = { providerID: 'openrouter', id: 'cheap/blind' };
  const { controller, ctx, switches } = await harness(lowAdvice, { low: 'openrouter/cheap/blind' });
  ctx.model.list = async () => ({
    data: [
      ...models,
      { ...blind, name: 'Blind', variants: [], ...priced(0.1, 0.4, 1_000_000), capabilities: { input: ['text'] } },
    ],
  });
  await send(controller, 'What is this?', 'ses_test', { messageID: 'msg_1' });
  assert.deepEqual(switches.at(-1)?.model, blind);
  await controller.remove('ses_test');
  switches.length = 0;
  ctx.session.get = async ({ sessionID }) => ({ id: sessionID, model: kimi, agent: 'build' });
  await controller.prompt({
    sessionID: 'ses_test',
    prompt: { text: 'And this?', files: [{ uri: 'file:///tmp/shot.png' }] },
  });
  assert.equal(switches.length, 0);
  assert.equal((await controller.snapshot('ses_test')).reason, 'model-unavailable');
  controller.close();
});

test('a third model mid-turn suspends routing for the turn', async () => {
  const { controller, switches, step, setAdvice } = await harness(lowAdvice);
  await send(controller);
  setAdvice(highAdvice);
  await step(tiny);
  assert.equal((await controller.snapshot('ses_test')).reason, 'native-fallback');
  assert.equal(switches.length, 0);
  controller.close();
});

test('the controller decides as chooseRoute does for the same scenario', async () => {
  const config = normalizeOptions({ classifier: 'ollama', routes: planRoutes, activities: planActivities });
  const cfg = routerConfig(config, models, kimi);
  const input = (advice) => ({
    facts: nativeFacts(cfg, emptyLoop(cfg, modelId(kimi)), {
      messages: [],
      prompt: 'Work',
      effort: null,
      contextTokens: 0,
    }),
    advice,
    pin: null,
    nativeModel: modelId(kimi),
    contextKnown: true,
    availableModels: availableModelIds(models),
    now: Date.now(),
  });
  for (const advice of [highAdvice, lowAdvice, planAdvice(0.95), planAdvice(0.4)]) {
    const direct = chooseRoute(
      cfg,
      { ...emptyLoop(cfg, modelId(kimi)), historyMeasured: true },
      input(fullAdvice(advice)),
    );
    const { controller } = await harness(advice, planRoutes, [], {}, null, planActivities);
    await send(controller);
    const state = await controller.snapshot('ses_test');
    assert.equal(state.tier, direct.decision.tier, JSON.stringify(advice));
    assert.equal(state.activity, direct.decision.activity, JSON.stringify(advice));
    assert.equal(state.reason, direct.decision.reason, JSON.stringify(advice));
    assert.equal(formatModelRef(state.nextModel), direct.decision.route.model, JSON.stringify(advice));
    controller.close();
  }
});

const shellCall = (id, command, metadata = { exit: 0 }, text = 'ok') => ({
  type: 'tool',
  id,
  name: 'shell',
  state: { status: 'completed', input: { command }, content: [{ type: 'text', text }], metadata },
});
const editCall = (id, path) => ({
  type: 'tool',
  id,
  name: 'edit',
  state: { status: 'completed', input: { path }, content: [{ type: 'text', text: 'edited' }] },
});
const toolRoutes = {
  low: 'openrouter/moonshotai/kimi-k3.1-pro#high',
  medium: 'openrouter/moonshotai/kimi-k3.1-pro#max',
  high: 'openai/gpt-6.1-sol#high',
};

test('repeated identical failures with an edit between them escalate one tier and hold', async () => {
  const { controller, switches, stored, reply, step } = await harness(lowAdvice, toolRoutes);
  await send(controller);
  stored.push({ type: 'user', text: 'Fix the test' });
  const failure = { exit: 1 };
  reply({ content: [shellCall('c1', 'npm test', failure, 'FAIL expected 1 got 2')] });
  reply({ content: [editCall('c2', 'a.mjs')] });
  reply({ content: [shellCall('c3', 'npm test', failure, 'FAIL expected 1 got 2')] });
  await send(controller, 'Try again');
  let state = await controller.snapshot('ses_test');
  assert.equal(state.reason, 'escalation');
  assert.equal(state.tier, 'medium');
  assert.equal(switches.at(-1).model.variant, 'max');
  await step();
  await send(controller, 'Once more');
  state = await controller.snapshot('ses_test');
  assert.equal(state.reason, 'hold');
  assert.equal(state.tier, 'medium');
  controller.close();
});

test('two different failures do not escalate', async () => {
  const { controller, reply } = await harness(lowAdvice, toolRoutes);
  await send(controller);
  reply({ content: [shellCall('c1', 'npm test', { exit: 1 }, 'FAIL one')] });
  reply({ content: [editCall('c2', 'a.mjs')] });
  reply({ content: [shellCall('c3', 'npm test', { exit: 1 }, 'FAIL two')] });
  await send(controller, 'Try again');
  assert.notEqual((await controller.snapshot('ses_test')).reason, 'escalation');
  controller.close();
});

const downgradeTurn = async (check) => {
  const advice = { ...highAdvice, continuation: 0.9 };
  const t = await harness(advice, toolRoutes, [], { model: openai });
  await send(t.controller);
  t.stored.push({ type: 'user', text: 'Write the tests' });
  await t.steps(9);
  t.setAdvice({ choice: 'low', confidence: 0.97, probabilities: { low: 0.97, high: 0.03 }, continuation: 0.9 });
  await send(t.controller, 'Vote one');
  await t.step();
  if (check) t.reply({ content: [editCall('c1', 'a.mjs'), shellCall('c2', 'npm test', check)] });
  await send(t.controller, 'Vote two');
  return t;
};

test('a same-task downgrade waits for a passed check', async () => {
  const held = await downgradeTurn(null);
  assert.equal((await held.controller.snapshot('ses_test')).reason, 'downgrade-held');
  assert.equal(held.switches.length, 0);
  held.controller.close();
  const failed = await downgradeTurn({ exit: 1 });
  assert.equal((await failed.controller.snapshot('ses_test')).reason, 'downgrade-held');
  failed.controller.close();
  const passed = await downgradeTurn({ exit: 0 });
  assert.equal((await passed.controller.snapshot('ses_test')).reason, 'downgrade');
  assert.deepEqual(passed.switches.at(-1).model, kimi);
  passed.controller.close();
});

test('a turn that edits code moves up to the code route at the next step', async () => {
  const activities = { code: { low: 'openai/gpt-6.1-sol#high' } };
  const advice = { ...lowAdvice, activity: { choice: 'ops', probabilities: { ops: 0.9 } } };
  const { controller, switches, stored, reply, step } = await harness(advice, toolRoutes, [], {}, null, activities);
  await send(controller);
  assert.equal(switches.length, 0);
  stored.push({ type: 'user', text: 'Tidy the config' });
  reply({ content: [editCall('c1', 'src/app.mjs')] });
  await step();
  assert.deepEqual(switches, [{ sessionID: 'ses_test', model: openai }]);
  const state = await controller.snapshot('ses_test');
  assert.equal(state.activity, 'code');
  assert.equal(state.reason, 'activity-up');
  assert.equal(state.decisions[0].origin, 'observed');
  controller.close();
});

test('a read-only turn stays on its route, and an observed move only goes up', async () => {
  const activities = { code: { low: 'openrouter/cheap/tiny' } };
  const advice = { ...lowAdvice, activity: { choice: 'ops', probabilities: { ops: 0.9 } } };
  const { controller, switches, stored, reply, step } = await harness(advice, toolRoutes, [], {}, null, activities);
  await send(controller);
  stored.push({ type: 'user', text: 'Tidy the config' });
  reply({ content: [shellCall('c1', 'ls')] });
  await step();
  reply({ content: [editCall('c2', 'src/app.mjs')] });
  await step();
  assert.equal(switches.length, 0);
  controller.close();
});

test('a tool call made after a review snapshot can still move the route up', async () => {
  const activities = { code: { low: 'openai/gpt-6.1-sol#high' } };
  const advice = { ...lowAdvice, activity: { choice: 'ops', probabilities: { ops: 0.9 } } };
  const { controller, switches, stored, reply, step, steps, setAnswer } = await harness(
    { ...advice, continuation: 0 },
    toolRoutes,
    [],
    {},
    null,
    activities,
  );
  await send(controller);
  stored.push({ type: 'user', text: 'Tidy the config' });
  await steps(5);
  const answered = [];
  setAnswer((input) => {
    answered.push(input);
    reply({ content: [editCall('c1', 'src/app.mjs')] });
    return { advice: fullAdvice(advice), error: null };
  });
  await steps(5);
  assert.equal(answered.length, 1);
  await step();
  assert.deepEqual(switches, [{ sessionID: 'ses_test', model: openai }]);
  controller.close();
});

const tierRoutes = {
  micro: 'openrouter/cheap/tiny',
  medium: 'openrouter/moonshotai/kimi-k3.1-pro#high',
  high: 'openai/gpt-6.1-sol#high',
};
const spawnEvent = (input) => ({
  tool: 'subagent',
  sessionID: 'ses_test',
  agent: 'build',
  input: { agent: 'general', description: 'Find the bug', prompt: 'Look around', ...input },
});

test('a spawn takes the tier model, chosen from the task text alone', async () => {
  const { controller, calls, stored, reply } = await harness(highAdvice, tierRoutes);
  stored.push({ type: 'user', text: 'Parent history stays out of it' });
  reply();
  const event = spawnEvent();
  await controller.spawn(event);
  assert.equal(event.input.model, 'openai/gpt-6.1-sol#high');
  assert.equal(calls[0].prompt, 'Find the bug\nLook around');
  assert.deepEqual(calls[0].turns, []);
  const state = await controller.snapshot('ses_test');
  assert.equal(state.decisions[0].origin, 'spawn');
  assert.equal(state.decisions[0].model, 'openai/gpt-6.1-sol#high');
  controller.close();
});

test('a spawn picks light for small work and standard for the rest', async () => {
  const pick = async (advice) => {
    const { controller } = await harness(advice, tierRoutes);
    const event = spawnEvent();
    await controller.spawn(event);
    controller.close();
    return event.input.model;
  };
  assert.equal(
    await pick({ choice: 'micro', confidence: 0.9, probabilities: { micro: 0.9 } }),
    'openrouter/cheap/tiny',
  );
  assert.equal(
    await pick({
      choice: 'medium',
      confidence: 0.9,
      probabilities: { medium: 0.9 },
      activity: { choice: 'explore', probabilities: { explore: 0.9 } },
    }),
    'openrouter/cheap/tiny',
  );
  assert.equal(
    await pick({ choice: 'medium', confidence: 0.9, probabilities: { medium: 0.9 } }),
    'openrouter/moonshotai/kimi-k3.1-pro#high',
  );
});

test('a spawn the router must not choose for passes unchanged, with its reason recorded', async () => {
  const cases = [
    ['explicit model', { model: 'openai/gpt-6.1-sol#high' }],
    ['pinned model', { agent: 'web' }],
    ['no definition', { agent: 'mystery' }],
    ['resumed', { sessionID: 'ses_child' }],
  ];
  for (const [reason, input] of cases) {
    const { controller, asks } = await harness(highAdvice, tierRoutes);
    const event = spawnEvent(input);
    const before = structuredClone(event.input);
    await controller.spawn(event);
    assert.deepEqual(event.input, before, reason);
    assert.equal(asks(), 0, reason);
    const row = (await controller.snapshot('ses_test')).decisions[0];
    assert.equal(row.reason, reason);
    if (input.model) assert.equal(row.model, input.model);
    if (input.agent === 'web') assert.equal(row.model, 'openrouter/cheap/tiny');
    controller.close();
  }
});

test('an empty model on a spawn is no model', async () => {
  const { controller } = await harness(highAdvice, tierRoutes);
  const event = spawnEvent({ model: '', sessionID: '' });
  await controller.spawn(event);
  assert.equal(event.input.model, 'openai/gpt-6.1-sol#high');
  controller.close();
});

test('other tools, routing off and subagent routing off leave a spawn alone', async () => {
  const on = await harness(highAdvice, tierRoutes);
  const other = { ...spawnEvent(), tool: 'shell' };
  await on.controller.spawn(other);
  assert.equal(other.input.model, undefined);
  await on.controller.setMode('ses_test', 'manual');
  const manual = spawnEvent();
  await on.controller.spawn(manual);
  assert.equal(manual.input.model, undefined);
  assert.equal(on.asks(), 0);
  on.controller.close();
  const off = await harness(highAdvice, tierRoutes, [], {}, null, {}, { subagentRouting: 'off' });
  const event = spawnEvent();
  await off.controller.spawn(event);
  assert.equal(event.input.model, undefined);
  off.controller.close();
  await assert.rejects(
    () => harness(highAdvice, tierRoutes, [], {}, null, {}, { subagentRouting: 'sometimes' }),
    /subagentRouting/,
  );
});

test('no advice or an unavailable route keeps the host pick', async () => {
  const silent = await harness(null, tierRoutes);
  const event = spawnEvent();
  await silent.controller.spawn(event);
  assert.equal(event.input.model, undefined);
  assert.equal((await silent.controller.snapshot('ses_test')).decisions[0].reason, 'no-advice');
  silent.controller.close();
  const missing = await harness(highAdvice, { ...tierRoutes, high: 'openai/not-connected#high' });
  const blocked = spawnEvent();
  await missing.controller.spawn(blocked);
  assert.equal(blocked.input.model, undefined);
  missing.controller.close();
});

test('a spawn waits at most three seconds', async () => {
  const { controller, calls } = await harness(highAdvice, tierRoutes, [], {}, null, {}, { ollamaTimeoutMs: 60_000 });
  await controller.spawn(spawnEvent());
  assert.equal(calls[0].config.classifiers.ollama.timeoutMs, 3000);
  controller.close();
});

test('spawn failures keep their own breaker, so they never pause the main turn', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('nope', { status: 400 }));
  const { controller } = await harness(highAdvice, tierRoutes, [], {}, {});
  for (let failure = 0; failure < 4; failure += 1) await controller.spawn(spawnEvent());
  assert.equal(fetch.mock.callCount(), 3);
  await send(controller);
  assert.equal(fetch.mock.callCount(), 4);
  assert.doesNotMatch((await controller.snapshot('ses_test')).error ?? '', /paused/);
  controller.close();
});

test('a child session keeps its spawn model for every step', async () => {
  const { controller, asks, switches, steps } = await harness(highAdvice, tierRoutes, [], { parentID: 'ses_parent' });
  await send(controller);
  await steps(9);
  await send(controller, 'A second message to the same child');
  assert.equal(asks(), 0);
  assert.equal(switches.length, 0);
  assert.equal((await controller.snapshot('ses_test')).reason, 'subagent');
  controller.close();
});

test('a failed spawn hook never fails the tool call', async (t) => {
  quietConsole(t);
  const { controller, ctx } = await harness(highAdvice, tierRoutes);
  ctx.model.list = async () => {
    throw new Error('host down');
  };
  const event = spawnEvent();
  await controller.spawn(event);
  assert.equal(event.input.model, undefined);
  controller.close();
});

test('a main session on an agent with its own model is left alone', async () => {
  const { controller, asks, switches, steps } = await harness(highAdvice, tierRoutes, [], { agent: 'web' });
  await send(controller);
  await steps(9);
  assert.equal(asks(), 0);
  assert.equal(switches.length, 0);
  assert.equal((await controller.snapshot('ses_test')).reason, 'fixed agent web');
  controller.close();
});

test('off returns the session to its native model and clears a pin', async () => {
  const { controller, switches, published } = await harness(highAdvice);
  await send(controller);
  await controller.setPin('ses_test', 'low');
  await controller.setMode('ses_test', 'manual');
  assert.deepEqual(switches.at(-1), { sessionID: 'ses_test', model: kimi });
  const state = published.at(-1);
  assert.equal(state.pendingPin, null);
  assert.deepEqual(state.nextModel, kimi);
  assert.equal(state.reason, 'routing off');
  assert.equal(state.switches, 1);
  controller.close();
});

test('off cancels a running review', async () => {
  const { controller, calls, setAnswer, steps } = await harness(highAdvice);
  await send(controller);
  setAnswer(() => new Promise(() => {}));
  await steps(5);
  await controller.setMode('ses_test', 'manual');
  assert.equal(calls[1].signal.aborted, true);
  controller.close();
});

test('a refused return to the native model is reported', async () => {
  const { controller, ctx, published } = await harness(highAdvice);
  await send(controller);
  ctx.session.switchModel = async () => {
    throw new Error('rejected');
  };
  await controller.setMode('ses_test', 'manual');
  assert.equal(published.at(-1).mode, 'manual');
  assert.equal(published.at(-1).error, 'rejected');
  controller.close();
});

test('routing resumes after off', async () => {
  const { controller, switches, step } = await harness(highAdvice);
  await send(controller);
  await step();
  await controller.setMode('ses_test', 'manual');
  await send(controller, 'Off');
  await step();
  await controller.setMode('ses_test', 'auto');
  await send(controller, 'On again');
  assert.deepEqual(switches.at(-1).model, openai);
  controller.close();
});

test('a session on a model no route runs starts with routing off', async () => {
  const routes = { micro: 'openai/gpt-6.1-sol#high', low: 'openai/gpt-6.1-sol#high' };
  const full = { ...routes, medium: 'openai/gpt-6.1-sol#high', high: 'openai/gpt-6.1-sol#high' };
  const { controller, asks } = await harness(highAdvice, full);
  const state = await controller.snapshot('ses_test');
  assert.equal(state.mode, 'manual');
  assert.equal(state.phase, 'manual');
  assert.equal(state.reason, 'not a routing tier');
  await send(controller);
  assert.equal(asks(), 0);
  controller.close();
  const routed = await harness(highAdvice, { ...full, medium: 'openrouter/moonshotai/kimi-k3.1-pro#max' });
  assert.equal((await routed.controller.snapshot('ses_test')).mode, 'auto');
  routed.controller.close();
});

test('a catalog failure at the start leaves routing on', async () => {
  const { controller, ctx } = await harness(highAdvice);
  ctx.model.list = async () => {
    throw new Error('host down');
  };
  assert.equal((await controller.snapshot('ses_test')).mode, 'auto');
  controller.close();
});

test('a pin needs routing on', async () => {
  const { controller } = await harness(highAdvice);
  await controller.setMode('ses_test', 'manual');
  await assert.rejects(() => controller.setPin('ses_test', 'low'), /Routing is off/);
  assert.equal((await controller.setPin('ses_test', null)).pendingPin, null);
  controller.close();
});

test('a model the user selects turns routing off, and the prompt runs on it', async () => {
  const { controller, asks, switches, selectModel, step } = await harness(lowAdvice, planRoutes);
  await send(controller);
  await step();
  const before = asks();
  selectModel(tiny);
  await send(controller, 'Use this one');
  const state = await controller.snapshot('ses_test');
  assert.equal(state.mode, 'manual');
  assert.equal(state.reason, 'model selected manually');
  assert.deepEqual(state.nextModel, tiny);
  assert.equal(asks(), before);
  assert.equal(switches.length, 0);
  controller.close();
});

test('off returns to the model selected while routing was off', async () => {
  const { controller, switches, selectModel, step } = await harness(highAdvice);
  await send(controller);
  await step();
  selectModel(tiny);
  await send(controller, 'Mine');
  await controller.setMode('ses_test', 'auto');
  await send(controller, 'Routed');
  assert.deepEqual(switches.at(-1).model, openai);
  await controller.setMode('ses_test', 'manual');
  assert.deepEqual(switches.at(-1).model, tiny);
  controller.close();
});

test('an agent switch that changes the model does not turn routing off', async () => {
  const { controller, selectModel, step, asks } = await harness(lowAdvice, planRoutes);
  await send(controller);
  await step();
  selectModel(openai, 'general');
  await send(controller, 'Other agent');
  const state = await controller.snapshot('ses_test');
  assert.equal(state.mode, 'auto');
  assert.equal(asks(), 2);
  controller.close();
});

test('the router switching a model is not a manual change', async () => {
  const { controller, step } = await harness(highAdvice);
  await send(controller);
  await step();
  await send(controller, 'Again');
  assert.equal((await controller.snapshot('ses_test')).mode, 'auto');
  controller.close();
});

test('a switch still in flight when a prompt arrives is not a manual change', async () => {
  const { controller, ctx, selectModel, setAnswer, steps, setAdvice } = await harness(lowAdvice, planRoutes);
  await send(controller);
  await steps(5);
  const release = {};
  const held = new Promise((resolve) => {
    release.go = resolve;
  });
  let holding = true;
  ctx.session.switchModel = async ({ model }) => {
    selectModel(model);
    if (holding) {
      holding = false;
      await held;
    }
  };
  setAnswer(null);
  setAdvice({ choice: 'high', confidence: 0.99, probabilities: { high: 0.99 } });
  await steps(5);
  await send(controller, 'During the switch');
  release.go();
  await settle();
  assert.equal((await controller.snapshot('ses_test')).mode, 'auto');
  controller.close();
});

test('a prompt steered into a running turn is not a turn', async () => {
  const { controller, asks, calls, setAnswer, setRunning, steps } = await harness(highAdvice);
  await send(controller);
  setAnswer(() => new Promise(() => {}));
  await steps(5);
  const before = asks();
  setRunning(true);
  await send(controller, 'Also check the docs');
  assert.equal(asks(), before);
  assert.equal(calls[1].signal.aborted, false);
  setRunning(false);
  setAnswer(null);
  await send(controller, 'A new turn');
  assert.equal(asks(), before + 1);
  controller.close();
});

test('a pin waits through a steered prompt for the next turn', async () => {
  const { controller, setRunning, step } = await harness(highAdvice);
  await send(controller);
  await step();
  await controller.setPin('ses_test', 'low');
  setRunning(true);
  await send(controller, 'Steered');
  assert.equal((await controller.snapshot('ses_test')).pendingPin, 'low');
  setRunning(false);
  await send(controller, 'New turn');
  assert.equal((await controller.snapshot('ses_test')).pendingPin, null);
  controller.close();
});

test('a turn that ends while the classifier runs reads as interrupted', async () => {
  const { controller, setAnswer } = await harness(highAdvice);
  const release = {};
  setAnswer(
    () =>
      new Promise((resolve) => {
        release.go = () => resolve({ advice: null, error: 'cancelled' });
      }),
  );
  const prompt = send(controller);
  await settle();
  await controller.idle('ses_test');
  const state = await controller.snapshot('ses_test');
  assert.equal(state.phase, 'ready');
  assert.equal(state.reason, 'interrupted');
  release.go();
  await prompt;
  controller.close();
});

test('compaction or a rewind clears the votes and the cache, and drops a running review', async () => {
  const { controller, calls, setAnswer, setAdvice, steps, step } = await harness(lowAdvice, planRoutes);
  await send(controller);
  await step();
  setAdvice(highAdvice);
  await send(controller, 'First vote');
  assert.equal((await controller.snapshot('ses_test')).reason, 'upgrade-pending');
  await step();
  setAnswer(() => new Promise(() => {}));
  await steps(5);
  await controller.resetHistory('ses_test');
  assert.equal(calls.at(-1).signal.aborted, true);
  controller.close();
});

test('a reset is a no-op for a session the router has not seen', async () => {
  const { controller } = await harness(highAdvice);
  await controller.resetHistory('ses_unknown');
  controller.close();
});

test('nothing from a routed turn stays on the line once routing stops choosing', async () => {
  const { controller, step } = await harness(highAdvice);
  await send(controller);
  await step();
  assert.equal((await controller.snapshot('ses_test')).tier, 'high');
  await controller.setMode('ses_test', 'manual');
  let state = await controller.snapshot('ses_test');
  assert.equal(state.tier, null);
  assert.equal(state.activity, null);
  await controller.setMode('ses_test', 'auto');
  await send(controller, 'Routed');
  assert.equal((await controller.snapshot('ses_test')).tier, 'high');
  const fixed = await harness(highAdvice, undefined, [], {}, null, {}, {}, { build: {}, plan: { model: tiny } });
  await send(fixed.controller);
  fixed.selectModel(tiny, 'plan');
  await send(fixed.controller, 'Plan agent');
  state = await fixed.controller.snapshot('ses_test');
  assert.equal(state.reason, 'fixed agent plan');
  assert.equal(state.tier, null);
  controller.close();
  fixed.controller.close();
});

const modeRoutes = {
  low: 'openrouter/cheap/tiny',
  medium: 'openrouter/moonshotai/kimi-k3.1-pro#high',
  high: 'openai/gpt-6.1-sol#high',
};
const mediumAdvice = { choice: 'medium', confidence: 0.9, probabilities: { medium: 0.9 } };

test('cost mode takes the cheaper route below and quality the route above', async () => {
  for (const [mode, expected] of [
    ['balanced', 'openrouter/moonshotai/kimi-k3.1-pro#high'],
    ['cost', 'openrouter/cheap/tiny'],
    ['quality', 'openai/gpt-6.1-sol#high'],
  ]) {
    const { controller } = await harness(mediumAdvice, modeRoutes, [], { model: openai });
    await controller.setRoutingMode('ses_test', mode);
    await send(controller);
    assert.equal(formatModelRef((await controller.snapshot('ses_test')).nextModel), expected, mode);
    controller.close();
  }
});

test('a pin runs its configured route in any mode', async () => {
  const { controller } = await harness(mediumAdvice, modeRoutes, [], { model: openai });
  await controller.setRoutingMode('ses_test', 'cost');
  await controller.setPin('ses_test', 'medium');
  await send(controller);
  assert.equal(formatModelRef((await controller.snapshot('ses_test')).nextModel), modeRoutes.medium);
  controller.close();
});

test('a mode comes from the session, then the project, then the profile', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencode-router-mode-'));
  const options = { mode: 'quality' };
  const { controller, ctx } = await harness(mediumAdvice, modeRoutes, [], {}, null, {}, options);
  ctx.location = { directory };
  const label = async () => (await controller.snapshot('ses_test')).routingMode;
  assert.equal(await label(), 'quality (profile)');
  mkdirSync(join(directory, '.opencode'));
  writeFileSync(join(directory, '.opencode/router.json'), '{"mode":"cost"}');
  assert.equal(await label(), 'cost (project)');
  await controller.setRoutingMode('ses_test', 'balanced');
  assert.equal(await label(), 'balanced (session)');
  await controller.setRoutingMode('ses_test', 'default');
  assert.equal(await label(), 'cost (project)');
  writeFileSync(join(directory, '.opencode/router.json'), '{"mode":"cost","routes":{}}');
  const state = await controller.snapshot('ses_test');
  assert.equal(state.routingMode, 'quality (profile)');
  assert.match(state.projectError, /\.opencode\/router\.json may only set mode/);
  controller.close();
  rmSync(directory, { recursive: true, force: true });
});

test('an unknown mode is refused', async () => {
  const { controller } = await harness(highAdvice);
  await assert.rejects(() => controller.setRoutingMode('ses_test', 'turbo'), /mode must be/);
  await assert.rejects(() => harness(highAdvice, undefined, [], {}, null, {}, { mode: 'turbo' }), /mode must be/);
  controller.close();
});

test('policy options override the defaults and bad ones are refused', async () => {
  const { controller, asks, steps } = await harness(
    highAdvice,
    undefined,
    [],
    {},
    null,
    {},
    {
      policy: { reviewEveryRequests: 2 },
    },
  );
  await send(controller);
  await steps(3);
  assert.equal(asks(), 2);
  controller.close();
  await assert.rejects(() => harness(highAdvice, undefined, [], {}, null, {}, { policy: { nope: 1 } }), /policy/);
  await assert.rejects(
    () => harness(highAdvice, undefined, [], {}, null, {}, { policy: { upgradeBase: 'high' } }),
    /policy/,
  );
});

test('a session survives a restart: mode, pin, votes, decisions and native model', async () => {
  const { controller, restart, setAdvice, step, switches } = await harness(lowAdvice, planRoutes);
  await send(controller);
  await step();
  setAdvice(highAdvice);
  await send(controller, 'First vote');
  await step();
  await controller.setRoutingMode('ses_test', 'cost');
  await controller.setPin('ses_test', 'low');
  const before = await controller.snapshot('ses_test');
  controller.close();
  const next = await restart();
  const after = await next.snapshot('ses_test');
  assert.equal(after.routingMode, 'cost (session)');
  assert.equal(after.pendingPin, 'low');
  assert.equal(after.decisions.length, before.decisions.length);
  assert.ok(after.sequence >= before.sequence);
  assert.deepEqual(after.nativeModel, kimi);
  await next.setPin('ses_test', null);
  await next.setRoutingMode('ses_test', 'default');
  await send(next, 'Second vote');
  assert.equal((await next.snapshot('ses_test')).reason, 'upgrade');
  assert.deepEqual(switches.at(-1).model, openai);
  next.close();
});

test('routing off survives a restart, and does not count as a manual start', async () => {
  const { controller, restart } = await harness(highAdvice);
  await controller.setMode('ses_test', 'manual');
  controller.close();
  const next = await restart();
  assert.equal((await next.snapshot('ses_test')).mode, 'manual');
  assert.equal((await next.snapshot('ses_test')).reason, 'routing off');
  next.close();
});

test('a saved session on an unknown phase does not restart as choosing', async () => {
  const { controller, ctx, restart } = await harness(highAdvice);
  await controller.snapshot('ses_test');
  await send(controller);
  controller.close();
  const key = [...ctx.storage.entries.keys()].find((name) => name.includes('ses_test'));
  ctx.storage.entries.set(key, { ...ctx.storage.entries.get(key), phase: 'choosing' });
  const next = await restart();
  assert.equal((await next.snapshot('ses_test')).phase, 'ready');
  next.close();
});

test('a deleted session leaves nothing saved', async () => {
  const { controller, ctx } = await harness(highAdvice);
  await send(controller);
  await controller.remove('ses_test');
  assert.equal(
    [...ctx.storage.entries.keys()].some((name) => name.includes('ses_test')),
    false,
  );
  controller.close();
});

test('a storage failure never blocks a hook or a publish', async (t) => {
  const log = quietConsole(t);
  const { controller, ctx, published } = await harness(highAdvice);
  ctx.storage.set = async () => {
    throw new Error('disk full');
  };
  await send(controller);
  assert.equal(published.at(-1).tier, 'high');
  assert.ok(log.mock.callCount() > 0);
  controller.close();
});

test('route edits survive a restart, reach every session, and can be undone', async () => {
  const { controller, restart, published } = await harness(highAdvice);
  await controller.snapshot('ses_other');
  await controller.setRoute('ses_test', 'high', 'openrouter/moonshotai/kimi-k3.1-pro#max');
  assert.equal(
    published.findLast((state) => state.sessionID === 'ses_other').routes.high,
    'openrouter/moonshotai/kimi-k3.1-pro#max',
  );
  await controller.setActivity('ses_test', 'off');
  controller.close();
  const next = await restart();
  let state = await next.snapshot('ses_test');
  assert.equal(state.routes.high, 'openrouter/moonshotai/kimi-k3.1-pro#max');
  assert.equal(state.activityRouting, 'off');
  assert.equal(state.canUndo, false);
  await next.setActivity('ses_test', 'on');
  await next.undo('ses_test');
  state = await next.snapshot('ses_test');
  assert.equal(state.activityRouting, 'off');
  assert.equal(state.canUndo, false);
  await assert.rejects(() => next.undo('ses_test'), /Nothing to undo/);
  next.close();
});

test('saved settings that no longer validate are ignored', async (t) => {
  const log = quietConsole(t);
  const { controller, ctx, restart } = await harness(highAdvice);
  await controller.setActivity('ses_test', 'off');
  controller.close();
  const key = [...ctx.storage.entries.keys()].find((name) => !name.startsWith('session'));
  ctx.storage.entries.set(key, { classifier: 'gone' });
  const next = await restart();
  assert.equal((await next.snapshot('ses_test')).classifier.id, 'ollama');
  assert.equal(log.mock.callCount(), 1);
  next.close();
});

test('a custom classifier can be configured and picked, and a bad one is refused', async () => {
  const classifiers = {
    mine: { label: 'Mine', api: 'ollama', endpoint: 'http://localhost:9/api', model: 'm', keyOption: null },
  };
  const { controller, calls } = await harness(highAdvice, undefined, [], {}, null, {}, { classifiers });
  await controller.setClassifier('ses_test', 'mine');
  const state = await controller.snapshot('ses_test');
  assert.deepEqual(state.classifier, { id: 'mine', label: 'Mine' });
  assert.ok(state.classifiers.some((entry) => entry.id === 'mine' && entry.label === 'Mine'));
  await send(controller);
  assert.equal(calls[0].config.classifier, 'mine');
  await assert.rejects(() => controller.setClassifier('ses_test', 'nope'), /unknown classifier/);
  controller.close();
  await assert.rejects(
    () => harness(highAdvice, undefined, [], {}, null, {}, { classifiers: { bad: { api: 'carrier-pigeon' } } }),
    /classifiers\.bad/,
  );
});

test('the classifier timeout can be set and a bad one is refused', async () => {
  const { controller, calls } = await harness(highAdvice);
  await controller.setTimeout('ses_test', 12_000);
  await send(controller);
  assert.equal(calls[0].config.classifiers.ollama.timeoutMs, 12_000);
  await assert.rejects(() => controller.setTimeout('ses_test', -1), /positive/);
  controller.close();
});

test('a session keeps a hundred decisions', async () => {
  const { controller } = await harness(lowAdvice);
  for (let turn = 0; turn < 105; turn += 1) await send(controller, `Turn ${turn}`);
  assert.equal((await controller.snapshot('ses_test')).decisions.length, 100);
  controller.close();
});

test('undoing the first edit removes it', async () => {
  const { controller, restart } = await harness(highAdvice);
  const route = (await controller.snapshot('ses_test')).routes.high;
  await controller.setRoute('ses_test', 'high', 'openrouter/moonshotai/kimi-k3.1-pro#max');
  await controller.undo('ses_test');
  assert.equal((await controller.snapshot('ses_test')).routes.high, route);
  controller.close();
  const next = await restart();
  assert.equal((await next.snapshot('ses_test')).routes.high, route);
  next.close();
});

test('a route edit saves only its tier, so the other tiers still follow the config', async () => {
  const { controller, ctx } = await harness(highAdvice, planRoutes);
  await controller.setRoute('ses_test', 'high', 'openrouter/moonshotai/kimi-k3.1-pro#max');
  controller.close();
  const edited = { ...planRoutes, low: 'openrouter/cheap/tiny' };
  const next = await createController(ctx, { classifier: 'ollama', routes: edited });
  const { routes } = await next.snapshot('ses_test');
  assert.equal(routes.low, 'openrouter/cheap/tiny');
  assert.equal(routes.high, 'openrouter/moonshotai/kimi-k3.1-pro#max');
  next.close();
});

test('reset clears saved settings back to the config, and can be undone', async () => {
  const { controller, ctx, restart } = await harness(highAdvice, planRoutes);
  const route = 'openrouter/moonshotai/kimi-k3.1-pro#max';
  await controller.setRoute('ses_test', 'high', route);
  await controller.setActivity('ses_test', 'off');
  await controller.reset('ses_test');
  let state = await controller.snapshot('ses_test');
  assert.equal(state.routes.high, planRoutes.high);
  assert.equal(state.activityRouting, 'on');
  assert.equal(state.canUndo, true);
  await controller.undo('ses_test');
  state = await controller.snapshot('ses_test');
  assert.equal(state.routes.high, route);
  await controller.reset('ses_test');
  controller.close();
  assert.deepEqual(
    [...ctx.storage.entries.keys()].filter((key) => !key.startsWith('session')),
    [],
  );
  const next = await restart();
  assert.equal((await next.snapshot('ses_test')).routes.high, planRoutes.high);
  next.close();
});

const costed = (cost, fields = {}) => ({ cost, ...fields });
const money = (usd) => Math.round(usd * 1e6) / 1e6;

test('session spend adds up to the cost the host reports', async () => {
  const { controller, reply } = await harness(highAdvice);
  await send(controller);
  reply(costed(0.25));
  reply(costed(0.5));
  reply(costed(0.125));
  await controller.idle('ses_test');
  const report = await controller.usage('ses_test', 'session');
  assert.equal(money(report.spendUsd), 0.875);
  assert.equal(report.replies, 3);
  controller.close();
});

test('every reply counts toward spend, however it was routed', async () => {
  const measured = async (t) => {
    const hook = () => t.controller.context({ sessionID: 'ses_test', agent: 'build', model: kimi, messages: [] });
    await send(t.controller);
    await hook();
    t.reply(costed(0.1));
    await hook();
    t.reply(costed(0.2));
    await hook();
    t.reply(costed(0.3));
    await t.controller.idle('ses_test');
    const report = await t.controller.usage('ses_test', 'session');
    assert.equal(money(report.spendUsd), 0.6);
    assert.equal(report.replies, 3);
    t.controller.close();
  };
  await measured(await harness(highAdvice));
  const off = await harness(highAdvice);
  await off.controller.setMode('ses_test', 'manual');
  await measured(off);
  await measured(await harness(highAdvice, undefined, ['build']));
});

test('replies that land before the first read all count', async () => {
  const { controller, reply } = await harness(lowAdvice);
  await send(controller);
  reply(costed(0.1));
  reply(costed(0.2));
  reply(costed(0.3));
  await controller.idle('ses_test');
  assert.equal(money((await controller.usage('ses_test', 'session')).spendUsd), 0.6);
  controller.close();
});

test('a session that stayed on its own model reads no difference from no routing', async () => {
  const { controller, reply, step } = await harness(lowAdvice);
  await send(controller);
  for (const cost of [0.1, 0.2, 0.3]) {
    await step();
    reply(costed(cost));
  }
  await controller.idle('ses_test');
  const report = await controller.usage('ses_test', 'session');
  assert.equal(report.differenceUsd, 0);
  assert.equal(report.routedUsd, report.yoursUsd);
  controller.close();
});

test('routing to a stronger model reads as a cost against no routing', async () => {
  const { controller, reply, step } = await harness(highAdvice);
  await send(controller);
  await step(openai);
  reply({
    ...costed(1),
    tokens: { input: 1000, output: 1000, reasoning: 0, cache: { read: 0, write: 0 } },
    model: openai,
  });
  await controller.idle('ses_test');
  const report = await controller.usage('ses_test', 'session');
  assert.ok(report.yoursUsd < report.routedUsd);
  assert.ok(report.strongerUsd > 0);
  assert.ok(report.whatIf.some((row) => row.model === modelId(kimi)));
  controller.close();
});

test('a reply without a list price is still spend', async () => {
  const { controller, ctx, reply, step } = await harness(lowAdvice);
  await send(controller);
  await step();
  ctx.model.list = async () => ({ data: [] });
  await controller.resetHistory('ses_test');
  reply({ ...costed(0.4), model: { providerID: 'gone', id: 'model' } });
  await controller.idle('ses_test');
  assert.equal(money((await controller.usage('ses_test', 'session')).spendUsd), 0.4);
  controller.close();
});

test('a period adds every session, and a session period only its own', async () => {
  const { controller, step, reply, ctx } = await harness(lowAdvice);
  await send(controller);
  reply(costed(0.5));
  await step();
  await controller.idle('ses_test');
  await send(controller, 'Other', 'ses_other');
  ctx.session.context = async () => [
    {
      type: 'assistant',
      model: kimi,
      cost: 0.25,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { completed: Date.now() + 1000 },
    },
  ];
  await controller.idle('ses_other');
  assert.equal(money((await controller.usage('ses_other', 'session')).spendUsd), 0.25);
  assert.equal(money((await controller.usage('ses_test', 'today')).spendUsd), 0.75);
  await assert.rejects(() => controller.usage('ses_test', 'decade'), /period/);
  controller.close();
});

test('usage survives a restart, and delete history clears it for good', async () => {
  const { controller, restart, reply, step, ctx } = await harness(lowAdvice);
  await send(controller);
  reply(costed(0.5));
  await step();
  await controller.idle('ses_test');
  controller.close();
  const next = await restart();
  assert.equal(money((await next.usage('ses_test', 'session')).spendUsd), 0.5);
  await next.deleteHistory('ses_test');
  assert.equal((await next.usage('ses_test', 'session')).spendUsd, 0);
  assert.equal((await next.usage('ses_test', 'all')).spendUsd, 0);
  assert.deepEqual(
    [...ctx.storage.entries.keys()].filter((key) => key.startsWith('usage:ses')),
    [],
  );
  next.close();
});

test('a subagent is measured against the model its parent would have run', async () => {
  const child = await harness(lowAdvice, undefined, [], { parentID: 'ses_parent' });
  const { controller, ctx, reply, step } = child;
  const get = ctx.session.get;
  ctx.session.get = async (input) =>
    input.sessionID === 'ses_parent'
      ? { id: 'ses_parent', agent: 'build', model: openai }
      : { ...(await get(input)), model: kimi };
  await send(controller);
  await step();
  reply({ ...costed(0.4), tokens: { input: 1000, output: 1000, reasoning: 0, cache: { read: 0, write: 0 } } });
  await controller.idle('ses_test');
  const report = await controller.usage('ses_test', 'session');
  assert.ok(report.routedUsd < report.yoursUsd);
  controller.close();
});

test('a pinned agent is measured against its own model', async () => {
  const { controller, ctx, reply, step } = await harness(lowAdvice, undefined, [], {
    parentID: 'ses_parent',
    agent: 'web',
  });
  const get = ctx.session.get;
  ctx.session.get = async (input) =>
    input.sessionID === 'ses_parent'
      ? { id: 'ses_parent', agent: 'build', model: openai }
      : { ...(await get(input)), model: kimi };
  await send(controller);
  await step();
  reply(costed(0.4));
  await controller.idle('ses_test');
  assert.equal((await controller.usage('ses_test', 'session')).differenceUsd, 0);
  controller.close();
});

test('the classifier agreement and its wait are reported', async () => {
  const advice = { ...lowAdvice, activity: { choice: 'ops', probabilities: { ops: 0.9 } } };
  const { controller, reply, stored, step } = await harness(advice);
  await send(controller);
  stored.push({ type: 'user', text: 'Run it' });
  reply({ content: [shellCall('c1', 'npm install')] });
  await step();
  await controller.idle('ses_test');
  const report = await controller.usage('ses_test', 'session');
  assert.deepEqual(report.agreement, { matched: 1, total: 1 });
  assert.equal(report.latency.turns, 1);
  controller.close();
});
