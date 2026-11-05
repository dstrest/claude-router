import assert from 'node:assert/strict';
import test from 'node:test';
import { createController } from '../opencode/controller.mjs';

const kimi = { providerID: 'openrouter', id: 'moonshotai/kimi-k3.1-pro', variant: 'high' };
const openai = { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'high' };
const models = [
  { providerID: kimi.providerID, id: kimi.id, name: 'Kimi', variants: [{ id: 'high' }, { id: 'max' }] },
  { providerID: openai.providerID, id: openai.id, name: 'GPT', variants: [{ id: 'high' }] },
];

async function harness(initialAdvice, routes = { high: 'openai/gpt-6.1-sol#high' }, fixedAgents = []) {
  const switches = [];
  const published = [];
  const current = { advice: initialAdvice, asks: 0 };
  const ctx = {
    options: {},
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, model: kimi, agent: 'build' }),
      context: async () => [],
      switchModel: async (input) => switches.push(input),
    },
    model: { list: async () => ({ data: models }) },
  };
  const controller = await createController(
    ctx,
    { classifier: 'ollama', routes, fixedAgents },
    {
      ask: async () => {
        current.asks += 1;
        return { advice: current.advice, error: null };
      },
    },
  );
  controller.setPublisher(async (state) => published.push(state));
  return {
    controller,
    switches,
    published,
    asks: () => current.asks,
    setAdvice: (next) => {
      current.advice = next;
    },
  };
}

test('prompt routing switches to the selected provider and records visible advice', async () => {
  const { controller, switches, published } = await harness({
    choice: 'high',
    confidence: 0.88,
    probabilities: { high: 0.93 },
    activity: { choice: 'debug', probabilities: { debug: 0.81 } },
  });
  await controller.prompt({ sessionID: 'ses_test', prompt: { text: 'Find the race condition' } });
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
  controller.close();
});

test('the context hook reveals the model serving active work', async () => {
  const { controller } = await harness({ choice: 'high', confidence: 0.8, probabilities: { high: 0.8 } });
  await controller.prompt({ sessionID: 'ses_test', prompt: { text: 'Work' } });
  await controller.context({ sessionID: 'ses_test', agent: 'build', model: openai, messages: [] });
  const state = await controller.snapshot('ses_test');
  assert.deepEqual(state.activeModel, openai);
  assert.deepEqual(state.nextModel, openai);
  assert.equal(state.requests, 1);
  controller.close();
});

test('manual mode never asks the classifier or switches the model', async () => {
  const advice = { choice: 'high', confidence: 1, probabilities: { high: 1 } };
  const { controller, switches, published } = await harness(advice);
  await controller.setMode('ses_test', 'manual');
  await controller.prompt({ sessionID: 'ses_test', prompt: { text: 'Work' } });
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
  await controller.prompt({ sessionID: 'ses_test', prompt: { text: 'Review this' } });
  const state = await controller.snapshot('ses_test');
  assert.equal(state.nextModel.variant, 'max');
  assert.equal(state.reason, 'pinned');
  assert.equal(asks(), 0);
  await assert.rejects(() => controller.setRoute('ses_test', 'extreme', 'openai/gpt-6.1-sol#high'), /unknown tier/);
  controller.close();
});

test('reviews need two votes and the dwell before a downgrade reaches the next turn', async () => {
  const { controller, switches, setAdvice } = await harness(
    { choice: 'high', confidence: 0.9, probabilities: { high: 0.9 } },
    {
      high: 'openai/gpt-6.1-sol#high',
      low: 'openrouter/moonshotai/kimi-k3.1-pro#high',
    },
  );
  const turns = async (count) => {
    for (let request = 0; request < count; request += 1) {
      await controller.context({ sessionID: 'ses_test', agent: 'build', model: openai, messages: [] });
      for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    }
  };
  await controller.prompt({ sessionID: 'ses_test', prompt: { text: 'Start difficult work' } });
  setAdvice({ choice: 'low', confidence: 0.9, probabilities: { low: 0.9, high: 0.1 } });
  await turns(4);
  assert.equal(switches.length, 1);
  assert.equal((await controller.snapshot('ses_test')).reason, 'downgrade-pending');
  await turns(4);
  const state = await controller.snapshot('ses_test');
  assert.equal(switches.length, 2);
  assert.deepEqual(switches[1].model, kimi);
  assert.deepEqual(state.activeModel, openai);
  assert.deepEqual(state.nextModel, kimi);
  assert.equal(state.decisions[0].origin, 'review');
  controller.close();
});

test('one noisy prompt does not move the model until a second vote agrees', async () => {
  const { controller, switches, setAdvice } = await harness(
    { choice: 'low', confidence: 0.9, probabilities: { low: 0.9 } },
    {
      low: 'openrouter/moonshotai/kimi-k3.1-pro#high',
      high: 'openai/gpt-6.1-sol#high',
    },
  );
  const prompt = async () => {
    await controller.prompt({ sessionID: 'ses_test', prompt: { text: 'Work' } });
    await controller.context({ sessionID: 'ses_test', agent: 'build', model: kimi, messages: [] });
  };
  await prompt();
  setAdvice({ choice: 'high', confidence: 0.8, probabilities: { high: 0.8, low: 0.2 } });
  await prompt();
  assert.equal(switches.length, 0);
  assert.equal((await controller.snapshot('ses_test')).reason, 'upgrade-pending');
  await prompt();
  assert.deepEqual(switches, [{ sessionID: 'ses_test', model: openai }]);
  assert.equal((await controller.snapshot('ses_test')).reason, 'upgrade');
  controller.close();
});

test('a confident two-tier jump moves on a single vote', async () => {
  const { controller, switches, setAdvice } = await harness(
    { choice: 'micro', confidence: 0.9, probabilities: { micro: 0.9 } },
    {
      micro: 'openrouter/moonshotai/kimi-k3.1-pro#high',
      high: 'openai/gpt-6.1-sol#high',
    },
  );
  await controller.prompt({ sessionID: 'ses_test', prompt: { text: 'Hi' } });
  await controller.context({ sessionID: 'ses_test', agent: 'build', model: kimi, messages: [] });
  setAdvice({ choice: 'high', confidence: 0.99, probabilities: { high: 0.99, micro: 0.01 } });
  await controller.prompt({ sessionID: 'ses_test', prompt: { text: 'Redesign it all' } });
  assert.deepEqual(switches, [{ sessionID: 'ses_test', model: openai }]);
  assert.equal((await controller.snapshot('ses_test')).reason, 'jump');
  controller.close();
});

test('a fixed agent keeps its own model and never asks the classifier', async () => {
  const { controller, switches, asks } = await harness({ choice: 'high', confidence: 1, probabilities: { high: 1 } });
  await controller.prompt({ sessionID: 'ses_test', prompt: { text: 'Plan' } });
  assert.equal(asks(), 1);
  const fixed = await harness({ choice: 'high', confidence: 1, probabilities: { high: 1 } }, undefined, ['build']);
  await fixed.controller.prompt({ sessionID: 'ses_test', prompt: { text: 'Plan' } });
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
