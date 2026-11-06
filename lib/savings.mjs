// Routing vs your model: what each main reply cost at configured list prices on the model that served it, against
// the same tokens on the session's own model and effort ("your model"). Counts and dollars only, never text. Pure:
// the hook feeds each reply and keeps it by day in usage.mjs's records. The records under SAVINGS_PREFIX are undated history from before those, read and never written.

import { effortSharesCache, ratesAt, writeMultiplierOf } from './cost.mjs';
import { canonicalModel } from './providers.mjs';
import { afterResetOf, earlierSince, isRecord } from './records.mjs';
import { HISTORY_SHRINK, isSameModel } from './route.mjs';

// Each session kept its own record under this prefix and its session id, as usage.mjs's records are now kept.
export const SAVINGS_PREFIX = 'savings:v1:';
// When Delete history last ran (ms), from any session: a session may still hold its record from before and write it back.
// The activity metrics records (METRICS_PREFIX) use it too.
export const SAVINGS_RESET_KEY = 'savings:reset:v1';
// Fewer replies than this read as an "early sample": one switch and its cache write dominate a short run.
export const EARLY_REPLIES = 10;
const TTLS = ['5m', '1h'];

// The model entry an API model id runs on: its configured id, a dated snapshot of it, or the id with a context
// suffix such as `[1m]`. Null when no entry prices it.
export function modelSpec(config, id) {
  if (typeof id !== 'string') return null;
  const bare = canonicalModel(id);
  const dated = (model) =>
    model.id.startsWith('claude-') && bare.startsWith(model.id) && /^-\d{8}$/.test(bare.slice(model.id.length));
  return Object.values(config.models).find((model) => isSameModel(model.id, bare) || dated(model)) ?? null;
}

// A by-model record's own entry for a models key, else undefined: router.json may name a model `toString`, which a
// plain object would otherwise answer from its prototype, or `null`, which a missing alias would coerce to.
export const modelEntry = (byModel, alias) =>
  typeof alias === 'string' && byModel && Object.hasOwn(byModel, alias) ? byModel[alias] : undefined;

// The router.json models key (`opus`) of the entry an API model id runs on, or null.
export function modelAlias(config, id) {
  const spec = modelSpec(config, id);
  return spec ? (Object.keys(config.models).find((alias) => config.models[alias] === spec) ?? null) : null;
}

// One request's list price in USD: `counts` are its uncached input, cache read, cache write and output tokens, the
// writes at `writeMultiplier` times input. Long-context rates follow the whole prompt, off-peak rates the time `at`.
export function requestUsd(
  model,
  { input, cacheRead, cacheWrite, output },
  writeMultiplier,
  cacheMode = 'explicit',
  at,
) {
  const rates = ratesAt(model, input + cacheRead + cacheWrite, at);
  const inputUsd =
    cacheMode === 'disabled'
      ? rates.input * (input + cacheRead + cacheWrite)
      : rates.input * (input + cacheWrite * writeMultiplier) + rates.cacheRead * cacheRead;
  return (inputUsd + rates.output * output) / 1e6;
}

// Actual observed counters can be priced without inventing the cache on another route.
export function observedReplyUsd(config, usage, ttl, at) {
  const counts = {
    input: usage?.input_tokens,
    cacheRead: usage?.cache_read_input_tokens,
    cacheWrite: usage?.cache_creation_input_tokens,
    output: usage?.output_tokens,
  };
  const model = modelSpec(config, usage?.model);
  const write = model && config.cache.mode === 'explicit' ? writeMultiplierOf(config, model, ttl) : 1;
  if (
    !model ||
    !Number.isFinite(model.output) ||
    !Number.isFinite(write) ||
    !Object.values(counts).every((n) => Number.isFinite(n) && n >= 0)
  )
    return null;
  return requestUsd(model, counts, write, config.cache.mode, at);
}

const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value ?? '').trim());

// The prompt-cache lifetime Claude Code gives the main conversation, by its own rule as of 2.1.296: FORCE_PROMPT_CACHING_5M,
// then CLAUDE_CODE_PROMPT_CACHE_TTL, then the `promptCacheTtl` setting, then ENABLE_PROMPT_CACHING_1H, then one hour
// for a Claude plan subscriber and five minutes otherwise. Its usage reports carry no 5m/1h split, so this is how the
// writes are priced. Limit: a subscriber billed as overage gets five minutes, which this cannot see.
export function sessionCacheTtl({ force5m, envTtl, settingTtl, enable1h, subscriber }) {
  if (truthy(force5m)) return '5m';
  if (TTLS.includes(envTtl)) return envTtl;
  if (TTLS.includes(settingTtl)) return settingTtl;
  if (truthy(enable1h) || subscriber) return '1h';
  return '5m';
}

// A subagent's prompt-cache lifetime, by Claude Code's rule for requests outside the main conversation: the same order
// with CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL and `subagentPromptCacheTtl`, and five minutes on a subscription too.
// Limit: an agent's `experimental.cacheTtl` frontmatter is not visible to a Mod.
export const subagentCacheTtl = ({ force5m, envTtl, settingTtl, enable1h }) =>
  sessionCacheTtl({ force5m, envTtl, settingTtl, enable1h, subscriber: false });

const isCount = (n) => Number.isFinite(n) && n >= 0;

// One main reply. `state` is your model's simulated cache: `{ total, at, onYours, model, effort }` after a reply, or
// null at the session start and after a compaction, which counts as on your model with nothing cached; a state of
// another model or effort (after `/model` or an effort change) counts as null. `served` is the route the
// reply ran on, `{ model, effort }` with the API's model id; `yours` the session's model and effort.
//
// Routed is the reply's usage on the served model. Yours is the same tokens on your model: while this reply and the
// one before it both ran on your route, the usage itself, so equal routes differ by exactly 0. Otherwise a single
// cache that never switched: it reads the previous prompt, up to this one less its uncached input, if that is inside
// the cache lifetime and no compaction shrank the history, and never less than the API actually read (a shared
// system-prompt cache, a lifetime longer than assumed); it writes the rest. Output tokens stay the same.
//
// The difference splits into the model price (the served model on your cache, against yours: cheaper models when
// negative, stronger than yours when positive) and the cache the switches cost (routed against the served model on
// your cache), never negative. The parts sum to the difference by construction. `reply` is null when a model has no
// price or `ttl` is not a known cache lifetime.
export function compareReply(config, state, { usage, served, yours, ttl, now }) {
  const counts = {
    input: usage?.input_tokens,
    cacheRead: usage?.cache_read_input_tokens,
    cacheWrite: usage?.cache_creation_input_tokens,
    output: usage?.output_tokens,
  };
  if (!Object.values(counts).every(isCount)) return { state, reply: null };
  const total = counts.input + counts.cacheRead + counts.cacheWrite;
  const [servedSpec, yoursSpec] = [modelSpec(config, served.model), modelSpec(config, yours.model)];
  const sameModel = servedSpec ? servedSpec === yoursSpec : served.model === yours.model;
  const identity = {
    model: yoursSpec?.id ?? yours.model,
    effort: yoursSpec?.efforts.length === 0 ? null : (yours.effort ?? null),
  };
  const servedEffort = servedSpec?.efforts.length === 0 ? null : (served.effort ?? null);
  // On a model that keeps one cache across efforts (effortSharesCache), an effort-only difference is the same cache.
  const sharedEffort = effortSharesCache(config, identity.model);
  const onYours = sameModel && (sharedEffort || servedEffort === identity.effort);
  const next = { total, at: now, onYours, ...identity };
  // A cache simulated for another model or effort of yours is none of this one's: the new one starts cold.
  const prior = state?.model === identity.model && (sharedEffort || state.effort === identity.effort) ? state : null;
  const writeOf = (spec) => (config.cache.mode === 'explicit' ? writeMultiplierOf(config, spec, ttl) : 1);
  if (
    !servedSpec ||
    !yoursSpec ||
    !Number.isFinite(servedSpec.output) ||
    !Number.isFinite(yoursSpec.output) ||
    !Number.isFinite(writeOf(servedSpec)) ||
    !Number.isFinite(writeOf(yoursSpec))
  )
    return { state: next, reply: null };
  // Implicit caches have no guaranteed TTL or cross-effort hit rate. Only identical observed routes compare exactly.
  if (config.cache.mode === 'automatic' && !(onYours && (prior?.onYours ?? true))) return { state: next, reply: null };
  const routedUsd = requestUsd(servedSpec, counts, writeOf(servedSpec), config.cache.mode, now);
  let yoursUsd = routedUsd;
  let servedOnYoursUsd = routedUsd;
  if (!(onYours && (prior?.onYours ?? true))) {
    const warm =
      config.cache.mode !== 'disabled' &&
      prior &&
      now - prior.at < config.cache.ttlMs[ttl] &&
      total >= prior.total * HISTORY_SHRINK &&
      prior.total > 0;
    const cacheRead = Math.max(counts.cacheRead, warm ? Math.min(prior.total, total - counts.input) : 0);
    const single = { ...counts, cacheRead, cacheWrite: total - counts.input - cacheRead };
    yoursUsd = requestUsd(yoursSpec, single, writeOf(yoursSpec), config.cache.mode, now);
    servedOnYoursUsd = requestUsd(servedSpec, single, writeOf(servedSpec), config.cache.mode, now);
  }
  const modelUsd = servedOnYoursUsd - yoursUsd;
  return {
    state: next,
    reply: {
      routedUsd,
      yoursUsd,
      cheaperUsd: Math.min(0, modelUsd),
      strongerUsd: Math.max(0, modelUsd),
      switchUsd: routedUsd - servedOnYoursUsd,
    },
  };
}

// Why a routed reply gets no price, by compareReply's checks in its order, or null when it prices it: the usage or its
// model id is missing or its counts do not read (`usage`; the hook drops a usage without a model before compareReply), the served model or your model has no configured price (`model`), or the cache
// lifetime is unknown (`ttl`). The usage record keeps priced replies only; this names what it leaves out.
export function unpricedCause(config, { usage, served, yours, ttl }) {
  const counts = [
    usage?.input_tokens,
    usage?.cache_read_input_tokens,
    usage?.cache_creation_input_tokens,
    usage?.output_tokens,
  ];
  if (!usage?.model || !counts.every(isCount)) return 'usage';
  const [servedSpec, yoursSpec] = [modelSpec(config, served.model), modelSpec(config, yours.model)];
  if (!servedSpec || !yoursSpec || !Number.isFinite(servedSpec.output) || !Number.isFinite(yoursSpec.output))
    return 'model';
  if (config.cache.mode === 'automatic') return 'ttl';
  return config.cache.mode === 'disabled' || Number.isFinite(config.cache.writeMultiplier[ttl]) ? null : 'ttl';
}

// One main reply against every configured model as yours, at your effort, so What if can price the same tokens on each
// model: `states` and `replies` by models key, each as compareReply returns, and `reply`, the prices against `yours`,
// the API model id /model selects now, or null.
export function compareModels(config, states, { usage, served, effort, ttl, now, yours }) {
  const out = { states: {}, replies: {}, reply: null };
  for (const [alias, model] of Object.entries(config.models)) {
    const { state, reply } = compareReply(config, modelEntry(states, alias) ?? null, {
      usage,
      served,
      yours: { model: model.id, effort },
      ttl,
      now,
    });
    out.states[alias] = state;
    if (reply) out.replies[alias] = reply;
  }
  out.reply = modelEntry(out.replies, modelAlias(config, yours)) ?? null;
  return out;
}

const SUMS = ['routedUsd', 'yoursUsd', 'cheaperUsd', 'strongerUsd', 'switchUsd'];

// A record kept across sessions, one session's or their sum: replies and the five sums since `since` (ms), the first
// reply after a reset.
export function emptySavingsStore() {
  return {
    version: 1,
    since: null,
    replies: 0,
    routedUsd: 0,
    yoursUsd: 0,
    cheaperUsd: 0,
    strongerUsd: 0,
    switchUsd: 0,
  };
}

const STORE_KEYS = Object.keys(emptySavingsStore());

// The stored value if it has the known shape, else an empty store: a missing, hand-edited or unknown value must not
// break a turn or the pane.
export function readSavingsStore(value) {
  const ok =
    isRecord(value) &&
    Object.keys(value).length === STORE_KEYS.length &&
    STORE_KEYS.every((key) => Object.hasOwn(value, key)) &&
    value.version === 1 &&
    (value.since === null || Number.isFinite(value.since)) &&
    Number.isSafeInteger(value.replies) &&
    value.replies >= 0 &&
    SUMS.every((sum) => Number.isFinite(value[sum]));
  return ok ? { ...value } : emptySavingsStore();
}

// A record whose first reply came before the last reset at `resetAt` (ms) reads as empty.
export const afterReset = (record, resetAt) => afterResetOf(record, resetAt, emptySavingsStore);

// The totals kept across sessions: every session's record since the last reset added up, since the earliest.
export function mergeSavingsStores(values, resetAt = null) {
  const merged = emptySavingsStore();
  for (const one of values.map((value) => afterReset(readSavingsStore(value), resetAt))) {
    merged.since = earlierSince(merged.since, one.since);
    merged.replies += one.replies;
    for (const sum of SUMS) merged[sum] += one[sum];
  }
  return merged;
}

const cents = (usd) => Math.round(usd * 100);

// What the UI shows for a set of totals, in whole cents so the shown parts add up: the difference is routed less
// yours as shown, and the switch part takes the rounding remainder. A surplus goes to the switch part if the totals
// have one, else to the stronger part if they have one, else to the cheaper part toward 0. A shortfall comes off the
// stronger part down to 0, then the cheaper part. So no part changes sign or appears from rounding alone. `early`
// below EARLY_REPLIES replies. `share` is the difference against yours; `ratio` routed over yours.
export function readout(totals) {
  const [routed, yours, cheaper, stronger] = [
    totals.routedUsd,
    totals.yoursUsd,
    totals.cheaperUsd,
    totals.strongerUsd,
  ].map(cents);
  const difference = routed - yours;
  const rest = difference - cheaper - stronger;
  const switches = totals.switchUsd ? Math.max(0, rest) : 0;
  const surplus = !totals.switchUsd && totals.strongerUsd ? Math.max(0, rest) : 0;
  const strongerShown = Math.max(0, stronger + Math.min(0, rest)) + surplus;
  return {
    replies: totals.replies,
    early: totals.replies < EARLY_REPLIES,
    routedUsd: routed / 100,
    yoursUsd: yours / 100,
    differenceUsd: difference / 100,
    cheaperUsd: (difference - strongerShown - switches) / 100,
    strongerUsd: strongerShown / 100,
    switchUsd: switches / 100,
    share: yours > 0 ? difference / yours : null,
    ratio: yours > 0 ? routed / yours : null,
  };
}
