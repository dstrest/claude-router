import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideRoute,
  formatModelRef,
  modelOptions,
  normalizeOptions,
  parseModelRef,
  sameModel,
} from '../opencode/config.mjs';

const kimi = 'openrouter/moonshotai/kimi-k3.1-pro#high';
const current = parseModelRef(kimi);

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

test('a classifier decision can select any configured provider and applies activity routes', () => {
  const config = normalizeOptions({
    routes: { medium: 'openai/gpt-6.1-sol#high', high: kimi },
    activities: { review: { medium: 'openrouter/moonshotai/kimi-k3.1-pro#max' } },
  });
  const decision = decideRoute({
    config,
    currentModel: current,
    advice: {
      choice: 'medium',
      confidence: 0.87,
      probabilities: { medium: 0.91 },
      activity: { choice: 'review', probabilities: { review: 0.76 } },
    },
    models: [
      { providerID: 'openai', id: 'gpt-6.1-sol', variants: [{ id: 'high' }] },
      { providerID: 'openrouter', id: 'moonshotai/kimi-k3.1-pro', variants: [{ id: 'max' }] },
    ],
  });
  assert.equal(formatModelRef(decision.nextModel), 'openrouter/moonshotai/kimi-k3.1-pro#max');
  assert.equal(decision.tier, 'medium');
  assert.equal(decision.tierConfidence, 0.87);
  assert.equal(decision.tierProbability, 0.91);
  assert.equal(decision.activity, 'review');
  assert.equal(decision.activityProbability, 0.76);
  assert.equal(decision.reason, 'activity override (same-tier)');
});

test('an unavailable route or missing advice keeps the current model', () => {
  const config = normalizeOptions({ routes: { high: 'openai/not-connected#high' } });
  const unavailable = decideRoute({
    config,
    currentModel: current,
    advice: { choice: 'high', confidence: 0.9, probabilities: { high: 0.9 } },
    models: [],
  });
  assert.deepEqual(unavailable.nextModel, current);
  assert.equal(unavailable.reason, 'model unavailable');

  const noAdvice = decideRoute({ config, currentModel: current, advice: null, error: 'unreachable', models: [] });
  assert.deepEqual(noAdvice.nextModel, current);
  assert.equal(noAdvice.reason, 'no classifier advice');
  assert.equal(noAdvice.error, 'unreachable');
});

test('a running default variant is the same model as a route without a variant', () => {
  const route = parseModelRef('openrouter/deepseek/deepseek-v4.1-flash-1017');
  assert.equal(sameModel({ ...route, variant: 'default' }, route), true);
  assert.equal(sameModel({ ...route, variant: 'high' }, route), false);
});
