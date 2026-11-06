import assert from 'node:assert/strict';
import test from 'node:test';
import { parseModelRef } from '../opencode/config.mjs';
import { fit, switchNotice } from '../opencode/status.mjs';

const haiku = parseModelRef('openrouter/anthropic/claude-haiku-5.5#high');
const opus = parseModelRef('openrouter/anthropic/claude-opus-5.5#high');
const opusMedium = parseModelRef('openrouter/anthropic/claude-opus-5.5#medium');
const flash = parseModelRef('openrouter/deepseek/deepseek-v4.1-flash-1017');
const state = (fields = {}) => ({
  phase: 'routed',
  activeModel: haiku,
  nextModel: opus,
  tier: 'high',
  activity: 'plan',
  reason: 'upgrade',
  switches: 0,
  ...fields,
});

test('the status names the active model, the next model, the route and the reason', () => {
  assert.equal(fit(state(), 80), 'claude-haiku-5.5#high → claude-opus-5.5#high · high/plan · ↑ needs stronger');
});

test('the status omits the next model when it is the active one', () => {
  assert.equal(
    fit(state({ nextModel: haiku, activity: null, reason: 'same-tier' }), 80),
    'claude-haiku-5.5#high · high · = fits',
  );
});

test('the status treats the default variant as no variant', () => {
  const line = fit(
    state({ activeModel: { ...flash, variant: 'default' }, nextModel: flash, tier: null, activity: null }),
    80,
  );
  assert.equal(line, 'deepseek-v4.1-flash-1017 · ↑ needs stronger');
});

test('the status does not print the default variant', () => {
  const line = fit(state({ activeModel: { ...flash, variant: 'default' }, nextModel: haiku }), 80);
  assert.match(line, /^deepseek-v4\.1-flash-1017 → claude-haiku-5\.5#high/);
});

test('the status drops the reason, then the active model, as the width shrinks', () => {
  const full = fit(state(), 200);
  const noReason = 'claude-haiku-5.5#high → claude-opus-5.5#high · high/plan';
  assert.equal(fit(state(), full.length), full);
  assert.equal(fit(state(), full.length - 1), noReason);
  assert.equal(fit(state(), noReason.length - 1), '→ claude-opus-5.5#high · high/plan');
  // Nothing fits: the narrowest form is returned for the renderer to truncate.
  assert.equal(fit(state(), 10), '→ claude-opus-5.5#high · high/plan');
  assert.equal(fit(state(), 0), '→ claude-opus-5.5#high · high/plan');
});

test('the status fits 80 columns with the longest configured models', () => {
  const line = fit(state({ activeModel: flash, nextModel: opusMedium, activity: 'review' }), 80);
  assert.ok(line.length <= 80, line);
});

test('the status says when the classifier is choosing and when an activity moved the route', () => {
  assert.match(fit(state({ phase: 'choosing', reason: null }), 80), /· choosing…$/);
  assert.match(fit(state({ reason: 'activity-up' }), 80), /· ↑ plan$/);
  assert.match(fit(state({ reason: 'fixed agent plan', tier: null }), 80), /· fixed agent plan$/);
});

test('the status is empty when the session has no model yet', () => {
  assert.equal(fit(state({ activeModel: null, nextModel: null }), 80), '');
});

test('a model change raises a notice in the Claude toast format', () => {
  assert.equal(
    switchNotice(state({ switches: 0 }), state({ switches: 1 })),
    'Model changed: claude-haiku-5.5#high → claude-opus-5.5#high · ↑ needs stronger',
  );
});

test('no notice without a new switch, for a pin, or for an effort-only change', () => {
  assert.equal(switchNotice(undefined, state({ switches: 3 })), null);
  assert.equal(switchNotice(state({ switches: 1 }), state({ switches: 1 })), null);
  assert.equal(switchNotice(state(), state({ switches: 1, reason: 'pinned' })), null);
  assert.equal(switchNotice(state(), state({ switches: 1, activeModel: opus, nextModel: opusMedium })), null);
});

test('no notice when a model of the move is unknown, and a later switch still gets one', () => {
  assert.equal(switchNotice(state(), state({ switches: 1, activeModel: null })), null);
  assert.equal(switchNotice(state(), state({ switches: 1, nextModel: null })), null);
  assert.match(switchNotice(state({ switches: 1 }), state({ switches: 2 })), /^Model changed/);
});

test('the status says what the classifier chose, even when the route stays', () => {
  const held = state({
    activeModel: flash,
    nextModel: flash,
    tier: 'low',
    activity: 'debug',
    reason: 'cash-gate',
    classifier: { label: 'Jev (OpenRouter)' },
    adviceChoice: 'high',
    activityChoice: 'review',
    tierConfidence: 0.92,
  });
  assert.equal(fit(held, 90), 'deepseek-v4.1-flash-1017 · low/debug · Jev high/review 92% · = cache cap');
});

test('the classifier reading goes first when the line is short', () => {
  const held = state({ adviceChoice: 'high', tierConfidence: 0.9, classifier: { label: 'Ollama' } });
  const full = fit(held, 200);
  assert.match(full, /Ollama high 90%/);
  assert.doesNotMatch(fit(held, full.length - 1), /Ollama/);
  assert.match(fit(held, full.length - 1), /↑ needs stronger$/);
});

test('an uncertain activity is not printed as a choice', () => {
  const held = state({
    adviceChoice: 'low',
    activityChoice: 'uncertain',
    tierConfidence: 0.5,
    classifier: { label: 'Jev' },
  });
  assert.match(fit(held, 200), /· Jev low 50% ·/);
});
