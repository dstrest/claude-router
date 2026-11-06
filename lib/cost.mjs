import { EFFORTS, routeSpec } from './config.mjs';
import { canonicalModel } from './providers.mjs';

// Models that keep one prompt cache across effort levels with an API key or a Claude subscription
// (code.claude.com/docs/en/prompt-caching, "Changing effort level"). A dated snapshot or a `[1m]` suffix is the same
// model. `config.effortSplitsCache`, set by the hook from the session's provider, gives every effort its own cache.
const EFFORT_SHARED_CACHE = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];

export function effortSharesCache(config, modelId) {
  if (typeof modelId !== 'string' || config.cache.mode === 'disabled') return false;
  if (config.cache.effortScope === 'shared') return true;
  if (['separate', 'unknown'].includes(config.cache.effortScope) || config.effortSplitsCache) return false;
  const bare = canonicalModel(modelId).replace(/-\d{8}$/, '');
  return EFFORT_SHARED_CACHE.includes(bare);
}

export function cacheKey(config, modelId, effort) {
  const id = canonicalModel(modelId);
  return effort && !effortSharesCache(config, modelId) ? `${id}@${effort}` : id;
}

export function clampEffort(wanted, supported) {
  if (!wanted || supported.length === 0) return null;
  if (supported.includes(wanted)) return wanted;
  for (let i = EFFORTS.indexOf(wanted); i >= 0; i -= 1) if (supported.includes(EFFORTS[i])) return EFFORTS[i];
  return supported[0];
}

// The one place a model's list prices become rates: per million tokens for a request whose prompt (input, cache read
// and cache write) is `promptTokens` at time `at`, with the model's long-context multiplier above its threshold and
// its off-peak multiplier outside peak hours. Every estimate prices through here.
// True when `at` (ms) falls outside the model's peak hours. An unknown time is peak: the higher bound.
export function isOffPeak(model, at) {
  if (!model.offPeak || !Number.isFinite(at)) return false;
  const time = new Date(at);
  const hour = time.getUTCHours();
  const peak =
    model.offPeak.peakDays.includes(time.getUTCDay()) &&
    model.offPeak.peakHoursUtc.some(([from, to]) => hour >= from && hour < to);
  return !peak;
}

export function ratesAt(model, promptTokens, at) {
  const k =
    (model.longContext && promptTokens > model.longContext.above ? model.longContext.multiplier : 1) *
    (isOffPeak(model, at) ? model.offPeak.multiplier : 1);
  return {
    input: model.input * k,
    cacheRead: model.cacheRead * k,
    output: Number.isFinite(model.output) ? model.output * k : undefined,
  };
}

// What a cache write bills at, as a multiple of the input price: the model's own when it sets one, for a host whose
// catalog prices each model, else the configured multiplier for `ttl`. An unknown `ttl` gives no number, so a reply
// whose cache lifetime cannot be read stays unpriced.
export const writeMultiplierOf = (config, model, ttl) => model.writeMultiplier ?? config.cache.writeMultiplier[ttl];
// The same for an estimate, where the lifetime is not known yet: the dearest one.
const coldWriteMultiplier = (config, model) =>
  model.writeMultiplier ?? Math.max(...Object.values(config.cache.writeMultiplier));

export function nextContextTokens(facts) {
  const previous = facts.lastRequest ? facts.lastRequest.tokens + facts.lastRequest.outputTokens : 0;
  return Math.max(previous, Number.isFinite(facts.contextTokens) ? facts.contextTokens : 0);
}

// Functions below take a route { model, effort }, not a tier: one tier can run on different routes.
export function routeEffort(config, route, sentEffort) {
  const model = routeSpec(config, route);
  if (model.efforts.length === 0) return null;
  if (route.effort) return clampEffort(route.effort, model.efforts);
  if (typeof sentEffort === 'number' && Number.isFinite(sentEffort)) return sentEffort;
  return clampEffort(sentEffort, model.efforts);
}

export function routeCacheKey(config, route, sentEffort) {
  return cacheKey(config, routeSpec(config, route).id, routeEffort(config, route, sentEffort));
}

export function isWarm(state, now, cache) {
  if (cache.mode && cache.mode !== 'explicit') return false;
  return Boolean(
    state?.prefixTokens > 0 && now >= state.lastAt && now < state.lastAt + cache.ttlMs['5m'] - cache.warmMarginMs,
  );
}

export function cacheState(state, now, cache) {
  return isWarm(state, now, cache) ? 'fresh' : 'unknown';
}

// Bounds are scenarios, never an independent ledger. Unknown incumbent cache can still be served.
export function inputBounds(config, route, tokens, facts, now) {
  const model = ratesAt(routeSpec(config, route), tokens, now);
  const state = facts.models[routeCacheKey(config, route, facts.effort)];
  const prefix = Math.min(state?.prefixTokens ?? tokens, tokens);
  const fresh = isWarm(state, now, config.cache);
  if (config.cache.mode === 'disabled') return { min: (model.input * tokens) / 1e6, max: (model.input * tokens) / 1e6 };
  if (config.cache.mode === 'automatic')
    return {
      // A miss can construct a prefix for the next request; last request's hits do not bound future hits.
      min: (model.cacheRead * tokens) / 1e6,
      max: (model.input * tokens) / 1e6,
    };
  const maximumWrite = model.input * coldWriteMultiplier(config, routeSpec(config, route));
  return {
    min: (model.cacheRead * prefix + model.input * (tokens - prefix)) / 1e6,
    max: fresh ? (model.cacheRead * prefix + maximumWrite * (tokens - prefix)) / 1e6 : (maximumWrite * tokens) / 1e6,
  };
}

export function coldWriteUsd(config, alias, tokens, now) {
  return (
    (ratesAt(config.models[alias], tokens, now).input *
      (config.cache.mode === 'explicit' ? coldWriteMultiplier(config, config.models[alias]) : 1) *
      tokens) /
    1e6
  );
}

// Routes that share a cache key (one model at two efforts, where effort keeps the cache) write the same new tokens
// to the same cache: switching between them costs no write. Bounding them apart would charge the new tokens as a tax.
export function switchingTaxUsd(config, candidate, incumbent, facts, now) {
  if (routeCacheKey(config, candidate, facts.effort) === routeCacheKey(config, incumbent, facts.effort)) return 0;
  const tokens = nextContextTokens(facts);
  return (
    inputBounds(config, candidate, tokens, facts, now).max - inputBounds(config, incumbent, tokens, facts, now).min
  );
}

// The next request on `candidate` against `incumbent` as a range: the input bounds crossed, plus the output difference
// at the last reply's length when both routes have an output price, as switchEconomics compares.
export function nextTurnRange(config, candidate, incumbent, facts, now) {
  const tokens = nextContextTokens(facts);
  const proposed = inputBounds(config, candidate, tokens, facts, now);
  const current = inputBounds(config, incumbent, tokens, facts, now);
  const [to, from] = [
    ratesAt(routeSpec(config, candidate), tokens, now),
    ratesAt(routeSpec(config, incumbent), tokens, now),
  ];
  const outputTokens = facts.lastRequest?.outputTokens ?? 0;
  const output = to.output > 0 && from.output > 0 ? ((to.output - from.output) * outputTokens) / 1e6 : 0;
  return { minUsd: proposed.min - current.max + output, maxUsd: proposed.max - current.min + output };
}

export function switchEconomics(config, candidate, incumbent, facts, now) {
  if (config.cache.mode === 'automatic') return null;
  const tokens = nextContextTokens(facts);
  const proposed = ratesAt(routeSpec(config, candidate), tokens, now);
  const current = ratesAt(routeSpec(config, incumbent), tokens, now);
  if (!(proposed.output > 0) || !(current.output > 0)) return null;
  const outputTokens = facts.lastRequest?.outputTokens ?? 0;
  const output = ((proposed.output - current.output) * outputTokens) / 1e6;
  const nextTurnUsd = switchingTaxUsd(config, candidate, incumbent, facts, now) + output;
  const laterTurnUsd = ((proposed.cacheRead - current.cacheRead) * tokens) / 1e6 + output;
  const paybackTurns =
    nextTurnUsd <= 0 && laterTurnUsd <= 0
      ? 0
      : nextTurnUsd > 0 && laterTurnUsd < 0
        ? Math.ceil(nextTurnUsd / -laterTurnUsd)
        : null;
  return { nextTurnUsd, laterTurnUsd, paybackTurns, outputTokens };
}

export function downgradeTaxUsd(config, candidate, incumbent, facts, now, turns) {
  // Same-model effort changes trade generated tokens and latency, not per-token rates. Input-only payback cannot
  // evaluate that saving. Keep votes, dwell and the cold-input cap; the displayed cache bounds still allow a miss.
  if (
    config.cache.mode === 'automatic' &&
    canonicalModel(routeSpec(config, candidate).id) === canonicalModel(routeSpec(config, incumbent).id)
  )
    return 0;
  const estimate = switchEconomics(config, candidate, incumbent, facts, now);
  if (!estimate) return Math.max(0, switchingTaxUsd(config, candidate, incumbent, facts, now));
  return Math.max(0, estimate.nextTurnUsd + (turns - 1) * estimate.laterTurnUsd);
}
