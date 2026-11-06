import { activeClassifier, EFFORTS, loadConfig, TIERS } from '../lib/config.mjs';

export function parseModelRef(value) {
  if (typeof value !== 'string') throw new Error('model must be a provider/model string');
  const [model, variant, ...rest] = value.split('#');
  const slash = model.indexOf('/');
  if (slash < 1 || slash === model.length - 1 || rest.length || variant === '')
    throw new Error(`invalid model "${value}": expected provider/model#variant`);
  const ref = { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
  if (variant !== undefined) ref.variant = variant;
  return ref;
}

export const formatModelRef = (ref) =>
  ref ? `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ''}` : 'none';

// OpenCode reports a model without a variant as `default` once it is running.
export const variantOf = (ref) => (ref?.variant === 'default' ? null : (ref?.variant ?? null));

// The model without its variant: lib/ reads this as the model id, and the host keeps one prompt cache per model.
export const modelId = (ref) => (ref ? `${ref.providerID}/${ref.id}` : null);

export const sameModel = (a, b) => a?.providerID === b?.providerID && a?.id === b?.id && variantOf(a) === variantOf(b);

const variantIDs = (model) =>
  (model.variants ?? []).map((variant) => (typeof variant === 'string' ? variant : variant.id));

export function modelOptions(models) {
  return models
    .filter((model) => model.enabled !== false)
    .flatMap((model) => {
      const refs = [undefined, ...variantIDs(model)];
      return refs.map((variant) => ({
        ref: formatModelRef({ providerID: model.providerID, id: model.id, variant }),
        name: `${model.name ?? model.id}${variant ? ` · ${variant}` : ' · default'}`,
      }));
    });
}

function available(models, ref) {
  if (!ref) return false;
  return models.some((model) => {
    if (model.providerID !== ref.providerID || model.id !== ref.id || model.enabled === false) return false;
    return !ref.variant || variantIDs(model).includes(ref.variant);
  });
}

function routeMap(routes = {}) {
  return Object.fromEntries(Object.entries(routes).map(([tier, ref]) => [tier, parseModelRef(ref)]));
}

export function normalizeOptions(options = {}) {
  const config = loadConfig();
  if (options.classifier && !config.classifiers[options.classifier] && options.classifier !== 'jev-openrouter')
    throw new Error(`unknown classifier "${options.classifier}"`);
  if (options.activityRouting && !['on', 'off'].includes(options.activityRouting))
    throw new Error('activityRouting must be "on" or "off"');
  if (
    options.ollamaTimeoutMs !== undefined &&
    (!Number.isFinite(options.ollamaTimeoutMs) || options.ollamaTimeoutMs <= 0)
  )
    throw new Error('ollamaTimeoutMs must be a positive number');
  return {
    ...config,
    classifier: options.classifier ?? config.classifier,
    classifiers: {
      ...config.classifiers,
      ollama: {
        ...config.classifiers.ollama,
        ...(options.ollamaModel ? { model: options.ollamaModel } : {}),
        ...(options.ollamaEndpoint ? { endpoint: options.ollamaEndpoint } : {}),
        ...(options.ollamaTimeoutMs ? { timeoutMs: options.ollamaTimeoutMs } : {}),
      },
      'jev-openrouter': {
        label: 'Jev (OpenRouter)',
        api: 'system-one',
        endpoint: 'https://openrouter.ai/api/v1/systemone',
        model: 'typesafe/jev-1.14',
        keyOption: 'openrouter_api_key',
        timeoutMs: 5000,
      },
    },
    // shortcut: one cache mode for every route; OpenRouter mixes explicit and automatic caches, so upgrade when a host setting names the mode per model.
    cache: { ...config.cache, effortScope: 'shared' },
    fixedAgents: options.fixedAgents ?? [],
    activityRouting: options.activityRouting ?? config.activityRouting,
    routeRefs: routeMap(options.routes),
    activityRefs: Object.fromEntries(
      Object.entries(options.activities ?? {}).map(([activity, routes]) => [activity, routeMap(routes)]),
    ),
  };
}

// Effort has no closed list here: variants are per model, so `efforts` stays empty and each variant is its own alias.
// `strength` keeps two variants of one model ordered, as price cannot.
function modelSpec(catalog, ref) {
  if (!available(catalog, ref))
    return {
      id: `unavailable/${formatModelRef(ref)}`,
      contextWindow: 0,
      input: 0,
      cacheRead: 0,
      billing: 'plan',
      efforts: [],
    };
  const entry = catalog.find((model) => model.providerID === ref.providerID && model.id === ref.id);
  const [base = {}, long] = [...(entry.cost ?? [])].sort((a, b) => (a.tier?.size ?? 0) - (b.tier?.size ?? 0));
  const input = base.input ?? 0;
  return {
    id: modelId(ref),
    contextWindow: entry.limit?.context ?? 0,
    input,
    cacheRead: base.cache?.read ?? 0,
    output: base.output,
    strength: Number.isFinite(base.output) ? base.output + (EFFORTS.indexOf(variantOf(ref)) + 1) / 1000 : undefined,
    // shortcut: only the first context tier is priced; upgrade if a model bills several.
    longContext: long?.tier && input > 0 ? { above: long.tier.size, multiplier: long.input / input } : undefined,
    imageInput: entry.capabilities?.input?.includes('image'),
    billing: input > 0 ? 'credits' : 'plan',
    efforts: [],
  };
}

const UNSET_MODEL = { providerID: 'native', id: 'unset' };

// The shared router's config for one turn: full refs become model aliases, and a tier without a route runs the session's own model.
export function routerConfig(config, catalog, nativeModel) {
  const models = {};
  const route = (ref) => {
    const model = formatModelRef({ ...ref, variant: variantOf(ref) ?? undefined });
    models[model] ??= modelSpec(catalog, ref);
    return { model, effort: null };
  };
  const native = nativeModel ?? UNSET_MODEL;
  const routes = Object.fromEntries(TIERS.map((tier) => [tier, route(config.routeRefs[tier] ?? native)]));
  const activities = Object.fromEntries(
    Object.entries(config.activityRefs).map(([activity, cells]) => [
      activity,
      Object.fromEntries(Object.entries(cells).map(([tier, ref]) => [tier, route(ref)])),
    ]),
  );
  route(native);
  return { ...config, models, routes, activities };
}

export const availableModelIds = (catalog) =>
  catalog.filter((model) => model.enabled !== false).map((model) => modelId(model));

export const classifierLabel = (config) => activeClassifier(config).label;
