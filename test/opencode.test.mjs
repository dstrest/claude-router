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
import { atHostCost, usageLines } from '../opencode/usage.mjs';

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

const toolMessage = (...content) => ({ type: 'assistant', content });
const shell = (id, command, state = {}) => ({
  type: 'tool',
  id,
  name: 'shell',
  state: { status: 'completed', input: { command }, content: [{ type: 'text', text: 'ok' }], ...state },
});

test('tool calls become tool_use blocks, each followed by its result', () => {
  const messages = routerMessages([
    toolMessage(
      { type: 'text', text: 'Running' },
      shell('call_1', 'npm test', { metadata: { exit: 0, truncated: false } }),
    ),
  ]);
  assert.deepEqual(messages, [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Running' },
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'Bash',
          input: { command: 'npm test', run_in_background: false },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', is_error: false, content: [{ type: 'text', text: 'ok' }] },
      ],
    },
  ]);
});

test('a shell failure is an error whatever the tool status says', () => {
  const failed = (metadata) =>
    routerMessages([toolMessage(shell('call_1', 'npm test', { metadata }))])[1].content[0].is_error;
  assert.equal(failed({ exit: 1 }), true);
  assert.equal(failed({ signal: 'SIGKILL' }), true);
  assert.equal(failed({ timeout: true }), true);
  assert.equal(failed({ exit: 0 }), false);
  assert.equal(failed(undefined), false);
});

test('a tool error carries its message, and an unfinished call has no result', () => {
  const [, result] = routerMessages([
    toolMessage({
      type: 'tool',
      id: 'call_1',
      name: 'edit',
      state: { status: 'error', input: { path: 'a.mjs' }, error: { type: 'tool', message: 'oldString not found' } },
    }),
  ]);
  assert.deepEqual(result.content, [
    {
      type: 'tool_result',
      tool_use_id: 'call_1',
      is_error: true,
      content: [{ type: 'text', text: 'oldString not found' }],
    },
  ]);
  const running = routerMessages([
    toolMessage({ type: 'tool', id: 'call_2', name: 'shell', state: { status: 'running', input: { command: 'ls' } } }),
    toolMessage({ type: 'tool', id: 'call_3', name: 'shell', state: { status: 'streaming', input: '{"comm' } }),
  ]);
  assert.equal(running.length, 2);
  assert.equal(running[1].content[0].input.command, undefined);
});

test('edits and patches name their files, as the activity and checkpoint rules read them', () => {
  const edited = (name, input) =>
    routerMessages([toolMessage({ type: 'tool', id: 'c', name, state: { status: 'running', input } })])[0].content;
  assert.deepEqual(edited('edit', { path: 'a.mjs' }), [
    { type: 'tool_use', id: 'c', name: 'Edit', input: { file_path: 'a.mjs' } },
  ]);
  assert.deepEqual(edited('write', { path: 'b.md' }), [
    { type: 'tool_use', id: 'c', name: 'Write', input: { file_path: 'b.md' } },
  ]);
  const patchText = '*** Begin Patch\n*** Update File: a.mjs\n@@\n-x\n+y\n*** Add File: docs/b.md\n+z\n*** End Patch';
  assert.deepEqual(
    edited('patch', { patchText }).map((block) => [block.name, block.input.file_path]),
    [
      ['Edit', 'a.mjs'],
      ['Edit', 'docs/b.md'],
    ],
  );
  assert.equal(edited('subagent', { agent: 'general' })[0].name, 'Agent');
  assert.equal(edited('grep', { pattern: 'x' })[0].name, 'grep');
});

test('a background command reads as a launch, and an image result counts as an image', () => {
  const [call, result] = routerMessages([
    toolMessage({
      type: 'tool',
      id: 'c',
      name: 'shell',
      state: {
        status: 'completed',
        input: { command: 'npm test', background: true },
        content: [
          { type: 'text', text: 'Command moved to the background (shell ID: s).' },
          { type: 'file', uri: 'media:abc', mime: 'image/png' },
          { type: 'file', uri: 'media:def', mime: 'text/plain' },
        ],
      },
    }),
  ]);
  assert.equal(call.content[0].input.run_in_background, true);
  assert.deepEqual(result.content[0].content, [
    { type: 'text', text: 'Command moved to the background (shell ID: s).' },
    { type: 'image' },
  ]);
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

test('a reply scales to the host cost, keeping its parts in proportion', () => {
  const reply = { routedUsd: 2, yoursUsd: 4, cheaperUsd: -3, strongerUsd: 0, switchUsd: 1 };
  assert.deepEqual(atHostCost(reply, 1), {
    routedUsd: 1,
    yoursUsd: 2,
    cheaperUsd: -1.5,
    strongerUsd: 0,
    switchUsd: 0.5,
  });
  assert.equal(atHostCost(reply, undefined), reply);
  assert.equal(atHostCost({ ...reply, routedUsd: 0 }, 1).yoursUsd, 4);
});

test('the usage report reads as routing against no routing', () => {
  const lines = usageLines({
    period: 'session',
    spendUsd: 1.25,
    replies: 4,
    comparedReplies: 4,
    early: true,
    routedUsd: 1.25,
    yoursUsd: 2,
    differenceUsd: -0.75,
    cheaperUsd: -0.8,
    strongerUsd: 0,
    switchUsd: 0.05,
    share: -0.375,
    whatIf: [{ model: 'openrouter/cheap/tiny', usd: 0.5 }],
    insights: [{ kind: 'switch', share: 0.2, usd: 0.05 }],
    agreement: { matched: 3, total: 4 },
    latency: { ms: 2000, over: false, turns: 4 },
  });
  assert.equal(lines[0], 'Usage (session): $1.25 over 4 replies · early sample');
  assert.equal(lines[1], 'Routing vs no routing (estimate): $1.25 vs $2.00 · -$0.75 (-38%)');
  assert.equal(lines[2], 'Cheaper models -$0.80 · stronger $0.00 · switches +$0.05');
  assert.ok(lines.includes('What if: openrouter/cheap/tiny $0.50'));
  assert.ok(lines.some((line) => /This session, the classifier agreed on 3 of 4 turns · p95 2.0s/.test(line)));
  assert.ok(lines.some((line) => /Switch cache writes took 20%/.test(line)));
});

test('an empty report says so', () => {
  assert.deepEqual(usageLines({ period: 'today', spendUsd: 0, replies: 0 }), ['Usage (today): no replies yet']);
});

test('a route with no variant on the session model keeps the session variant', () => {
  const session = parseModelRef('openrouter/moonshotai/kimi-k3.1-pro#high');
  const config = normalizeOptions({
    routes: { high: 'openrouter/moonshotai/kimi-k3.1-pro#max' },
    activities: { debug: { low: 'openrouter/moonshotai/kimi-k3.1-pro' } },
  });
  const cfg = routerConfig(config, [], session);
  assert.equal(cfg.activities.debug.low.model, 'openrouter/moonshotai/kimi-k3.1-pro#high');
  assert.equal(cfg.routes.high.model, 'openrouter/moonshotai/kimi-k3.1-pro#max');
  const other = routerConfig(config, [], parseModelRef('openai/gpt-6.1-sol#high'));
  assert.equal(other.activities.debug.low.model, 'openrouter/moonshotai/kimi-k3.1-pro');
});

test('the default variant is available wherever the model is', () => {
  const ref = parseModelRef('openrouter/deepseek/deepseek-v4.1-flash-1017');
  const catalog = [
    {
      ...ref,
      variants: [{ id: 'high' }],
      limit: { context: 1_000_000 },
      cost: [{ input: 0.3, output: 1.2, cache: { read: 0.01, write: 0.3 } }],
    },
  ];
  const config = normalizeOptions({ routes: { low: formatModelRef(ref) } });
  const cfg = routerConfig(config, catalog, { ...ref, variant: 'default' });
  assert.deepEqual(Object.keys(cfg.models), [formatModelRef(ref)]);
  assert.equal(cfg.models[formatModelRef(ref)].id, 'openrouter/deepseek/deepseek-v4.1-flash-1017');
  assert.equal(cfg.models[formatModelRef(ref)].contextWindow, 1_000_000);
});

test('a comparison over fewer replies than the spend says so, and a slow p95 is a bound', () => {
  const lines = usageLines({
    period: 'today',
    spendUsd: 1,
    replies: 7,
    comparedReplies: 6,
    routedUsd: 0.9,
    yoursUsd: 1,
    differenceUsd: -0.1,
    cheaperUsd: -0.1,
    strongerUsd: 0,
    switchUsd: 0,
    share: -0.1,
    agreement: { matched: 1, total: 1 },
    latency: { ms: 8000, over: true, turns: 1 },
  });
  assert.equal(lines[1], 'Routing vs no routing (estimate, 6 of 7 replies): $0.90 vs $1.00 · -$0.10 (-10%)');
  assert.ok(lines.some((line) => /p95 over 8\.0s/.test(line)));
});
