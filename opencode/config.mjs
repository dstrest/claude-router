import { activeClassifier, loadConfig, TIERS } from '../lib/config.mjs';
import { decide, initialState } from '../lib/policy.mjs';

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
const variantOf = (ref) => (ref?.variant === 'default' ? null : (ref?.variant ?? null));

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
  return models.some((model) => {
    if (model.providerID !== ref.providerID || model.id !== ref.id || model.enabled === false) return false;
    return !ref.variant || variantIDs(model).includes(ref.variant);
  });
}

function routeMap(routes = {}) {
  return Object.fromEntries(Object.entries(routes).map(([tier, ref]) => [tier, parseModelRef(ref)]));
}

export function normalizeOptions(options = {}) {
  const config = loadConfig({ provider: 'kimi' });
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
    fixedAgents: options.fixedAgents ?? [],
    activityRouting: options.activityRouting ?? config.activityRouting,
    routeRefs: routeMap(options.routes),
    activityRefs: Object.fromEntries(
      Object.entries(options.activities ?? {}).map(([activity, routes]) => [activity, routeMap(routes)]),
    ),
  };
}

// The shared classifier only needs route descriptions and effort labels. Full OpenCode refs stay in routeRefs.
export function classifierConfig(config, currentModel) {
  const routes = Object.fromEntries(
    TIERS.map((tier) => {
      const ref = config.routeRefs[tier] ?? currentModel;
      return [tier, { model: formatModelRef(ref), effort: ref.variant ?? null }];
    }),
  );
  return { ...config, routes };
}

// shortcut: OpenCode routes carry no prices yet, so switches cost nothing and cost gates never fire; upgrade when usage accounting is ported.
const noCosts = {
  switchingTaxUsd: () => 0,
  downgradeTaxUsd: () => 0,
  routeCacheKey: (_config, route) => route.model,
  cacheState: () => 'unknown',
};

export function decideRoute({
  config,
  currentModel,
  previousTier = null,
  pin = null,
  advice,
  error = null,
  models,
  policyState = initialState(),
  facts = {},
  now = Date.now(),
}) {
  const base = {
    tierConfidence: advice?.confidence ?? null,
    error,
  };
  if (pin) {
    const requested = config.routeRefs[pin] ?? currentModel;
    return {
      ...base,
      tier: pin,
      tierProbability: null,
      activity: null,
      activityChoice: null,
      activityProbability: null,
      nextModel: available(models, requested) ? requested : currentModel,
      reason: available(models, requested) ? 'pinned' : 'model unavailable',
    };
  }
  if (!advice || !TIERS.includes(advice.choice))
    return {
      ...base,
      nextModel: currentModel,
      reason: advice ? 'classifier uncertain' : 'no classifier advice',
    };
  const routeFor = (tier) => ({ model: formatModelRef(config.routeRefs[tier] ?? currentModel), effort: null });
  // The first decision has no incumbent tier to defend, so it takes the classifier's choice.
  const step = decide({
    config: {
      ...config,
      models: Object.fromEntries(TIERS.map((tier) => [routeFor(tier).model, { billing: 'plan' }])),
    },
    facts: { models: {}, ...facts, lastRoute: previousTier },
    advice: {
      ...advice,
      probabilities: { ...Object.fromEntries(TIERS.map((tier) => [tier, 0])), ...advice.probabilities },
    },
    state: policyState,
    baseline: advice.choice,
    now,
    costs: noCosts,
    routeFor,
  });
  const tier = step.tier;
  const activityAnswer = advice.activity;
  const activityProbability = activityAnswer ? (activityAnswer.probabilities[activityAnswer.choice] ?? null) : null;
  const activity =
    config.activityRouting === 'on' &&
    activityAnswer &&
    activityAnswer.choice !== 'uncertain' &&
    activityProbability >= config.policy.activityMass
      ? activityAnswer.choice
      : null;
  const override = activity ? config.activityRefs[activity]?.[tier] : null;
  const requested = override ?? config.routeRefs[tier] ?? currentModel;
  const tierProbability = advice.probabilities[tier] ?? null;
  if (!available(models, requested))
    return {
      ...base,
      tier,
      tierProbability,
      activity,
      activityProbability,
      policy: step.state,
      nextModel: currentModel,
      reason: 'model unavailable',
    };
  return {
    ...base,
    tier,
    tierProbability,
    activity,
    activityChoice: activityAnswer?.choice ?? null,
    activityProbability,
    policy: step.state,
    nextModel: requested,
    reason: override ? `activity override (${step.reason})` : step.reason,
  };
}

export const classifierLabel = (config) => activeClassifier(config).label;
