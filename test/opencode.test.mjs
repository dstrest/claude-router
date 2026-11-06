import assert from 'node:assert/strict';
import test from 'node:test';
import {
  availableModelIds,
  formatModelRef,
  modelOptions,
  normalizeOptions,
  parseModelRef,
  routerConfig,
  sameModel,
} from '../opencode/config.mjs';
import { promptHasImages, routerMessages, stopReasonOf, usageOf } from '../opencode/messages.mjs';

const kimi = 'openrouter/moonshotai/kimi-k3.1-pro#high';
const current = parseModelRef(kimi);
const kimiRef = current;

test('OpenCode model refs retain the provider, slashes, and variant', () => {
  assert.deepEqual(parseModelRef(kimi), {
    providerID: 'openrouter',
    id: 'moonshotai/kimi-k3.1-pro',
    variant: 'high',
  });
  assert.equal(formatModelRef(current), kimi);
  assert.equal(formatModelRef(parseModelRef('ollama/qwen3:8b')), 'ollama/qwen3:8b');
  assert.throws(() => parseModelRef('kimi-k3.1-pro'), /provider\/model/);
});

test('model choices include every available provider and every model variant', () => {
  const choices = modelOptions([
    {
      providerID: 'openrouter',
      id: 'moonshotai/kimi-k3.1-pro',
      name: 'Kimi K3.1 Pro',
      variants: [{ id: 'low' }, { id: 'high' }],
    },
    { providerID: 'ollama', id: 'qwen3:8b', name: 'Qwen 3', variants: [] },
    { providerID: 'openai', id: 'gpt-disabled', name: 'Disabled', enabled: false, variants: [] },
  ]);
  assert.deepEqual(
    choices.map((choice) => choice.ref),
    [
      'openrouter/moonshotai/kimi-k3.1-pro',
      'openrouter/moonshotai/kimi-k3.1-pro#low',
      'openrouter/moonshotai/kimi-k3.1-pro#high',
      'ollama/qwen3:8b',
    ],
  );
});

test('the router config maps every ref to an alias with catalog limits and prices', () => {
  const opus = parseModelRef('openrouter/anthropic/claude-opus-5.5#high');
  const config = normalizeOptions({
    routes: { high: 'openrouter/anthropic/claude-opus-5.5#medium', low: 'ollama/qwen3:8b' },
    activities: { plan: { low: 'openrouter/anthropic/claude-opus-5.5#high' } },
  });
  const catalog = [
    {
      providerID: 'openrouter',
      id: 'anthropic/claude-opus-5.5',
      variants: [{ id: 'medium' }, { id: 'high' }],
      limit: { context: 200_000, output: 32_000 },
      capabilities: { input: ['text', 'image'] },
      cost: [
        { tier: { type: 'context', size: 100_000 }, input: 10, output: 50, cache: { read: 1, write: 12.5 } },
        { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
      ],
    },
    {
      providerID: 'ollama',
      id: 'qwen3:8b',
      variants: [],
      limit: { context: 32_000 },
      capabilities: { input: ['text'] },
      cost: [],
    },
  ];
  const cfg = routerConfig(config, catalog, current);
  assert.deepEqual(cfg.routes.high, { model: 'openrouter/anthropic/claude-opus-5.5#medium', effort: null });
  assert.deepEqual(cfg.activities.plan.low, { model: formatModelRef(opus), effort: null });
  const medium = cfg.models['openrouter/anthropic/claude-opus-5.5#medium'];
  const high = cfg.models['openrouter/anthropic/claude-opus-5.5#high'];
  assert.equal(medium.id, 'openrouter/anthropic/claude-opus-5.5');
  assert.equal(high.id, medium.id);
  assert.equal(medium.contextWindow, 200_000);
  assert.equal(medium.billing, 'credits');
  assert.deepEqual(medium.longContext, { above: 100_000, multiplier: 2 });
  assert.equal(medium.imageInput, true);
  assert.deepEqual(medium.efforts, []);
  assert.ok(high.strength > medium.strength);
  const local = cfg.models['ollama/qwen3:8b'];
  assert.equal(local.billing, 'plan');
  assert.equal(local.imageInput, false);
  assert.equal(local.longContext, undefined);
});

test('a tier without a route runs the session model, and an unavailable route cannot be allowed', () => {
  const cfg = routerConfig(normalizeOptions({ routes: { high: 'openai/not-connected#high' } }), [], current);
  assert.equal(cfg.routes.low.model, kimi);
  assert.match(cfg.models['openai/not-connected#high'].id, /^unavailable\//);
  assert.deepEqual(
    availableModelIds([
      { providerID: 'a', id: 'b' },
      { providerID: 'c', id: 'd', enabled: false },
    ]),
    ['a/b'],
  );
});

test('a running default variant shares an alias with a route without one', () => {
  const route = 'openrouter/deepseek/deepseek-v4.1-flash-1017';
  const cfg = routerConfig(normalizeOptions({ routes: { low: route } }), [], {
    ...parseModelRef(route),
    variant: 'default',
  });
  assert.deepEqual(Object.keys(cfg.models), [route]);
});

test('stored messages become the turns lib/facts.mjs reads', () => {
  const messages = routerMessages([
    { type: 'user', text: 'Look', files: [{ uri: 'data:image/png;base64,AAAA' }, { uri: 'file:///notes.txt' }] },
    {
      type: 'assistant',
      content: [
        { type: 'reasoning', text: 'Hm' },
        { type: 'text', text: 'Seen' },
      ],
    },
    { type: 'idle', outcome: 'succeeded' },
  ]);
  assert.deepEqual(messages, [
    { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Seen' }] },
  ]);
  assert.equal(promptHasImages([{ name: 'shot.JPEG' }]), true);
  assert.equal(promptHasImages([{ uri: 'file:///notes.txt' }]), false);
  assert.equal(promptHasImages(undefined), false);
});

test('step tokens become Anthropic-style usage, and overflow text becomes a stop reason', () => {
  const message = {
    model: kimiRef,
    tokens: { input: 4, output: 10, reasoning: 5, cache: { read: 13_743, write: 82 } },
    finish: 'stop',
  };
  assert.deepEqual(usageOf(message), {
    model: 'openrouter/moonshotai/kimi-k3.1-pro',
    input_tokens: 4,
    cache_read_input_tokens: 13_743,
    cache_creation_input_tokens: 82,
    output_tokens: 15,
  });
  assert.equal(stopReasonOf(message), 'stop');
  assert.equal(
    stopReasonOf({ error: { type: 'provider', message: 'prompt is too long: 250000 tokens > 200000 maximum' } }),
    'model_context_window_exceeded',
  );
});

test('a running default variant is the same model as a route without a variant', () => {
  const route = parseModelRef('openrouter/deepseek/deepseek-v4.1-flash-1017');
  assert.equal(sameModel({ ...route, variant: 'default' }, route), true);
  assert.equal(sameModel({ ...route, variant: 'high' }, route), false);
});
