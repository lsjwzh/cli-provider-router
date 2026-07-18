'use strict';

// Pure model-selection policy shared by standalone CPR and embedding hosts.
// This module deliberately does not resolve providers from a store: callers
// pass either a public ProviderSummary or the raw Provider they already hold.

const TOML = require('@iarna/toml');
const { ALIAS_TIER_REGEX, ALIAS_TIER_KEYS } = require('./constants');

/**
 * Remove a terminal display/capability suffix such as "[1M]".
 * Provider catalogs use these suffixes for presentation, but upstream APIs
 * expect the bare model id on the wire.
 */
function stripModelSuffix(model) {
  return String(model || '').trim().replace(/\[[^\]]*\]$/, '').trim();
}

function parseSettingsConfig(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return {}; }
}

function parseToml(value) {
  try { return TOML.parse(String(value || '')); } catch (_) { return {}; }
}

function addModels(target, values) {
  for (const value of values || []) {
    const items = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
    for (const item of items) {
      const model = String(item || '').trim();
      if (model && !target.includes(model)) target.push(model);
    }
  }
}

function catalogModels(config) {
  return config && config.modelCatalog && Array.isArray(config.modelCatalog.models)
    ? config.modelCatalog.models.map(entry => entry && (entry.model || entry.id)).filter(Boolean)
    : [];
}

// Normalize only the fields needed by policy. Accepting both shapes lets an
// embedding host validate before or after asking ProviderStore for a summary.
function providerPolicy(appType, provider) {
  if (!provider || typeof provider !== 'object') return null;
  const type = String(appType || provider.appType || '').toLowerCase();
  const config = parseSettingsConfig(provider.settingsConfig);
  const modelOptions = [];
  const aliasMap = {};
  let baseUrl = provider.baseUrl || '';
  let model = provider.model || '';

  addModels(modelOptions, [provider.modelOptions, provider.models, model]);

  if (type === 'claude') {
    const env = config.env || {};
    baseUrl = baseUrl || env.ANTHROPIC_BASE_URL || '';
    model = model || env.ANTHROPIC_MODEL || '';
    addModels(modelOptions, [model, catalogModels(config)]);
    for (const [tier, key] of Object.entries(ALIAS_TIER_KEYS)) {
      const explicit = provider.aliasMap && provider.aliasMap[tier];
      const configured = env[key];
      const entry = explicit !== undefined ? explicit : configured;
      if (entry !== undefined && entry !== null) aliasMap[tier] = entry;
      const aliasModel = entry && typeof entry === 'object' ? entry.model : entry;
      addModels(modelOptions, [aliasModel]);
    }
  } else if (type === 'codex') {
    const parsed = parseToml(config.config);
    const selectedName = parsed.model_provider;
    const selected = selectedName && parsed.model_providers && parsed.model_providers[selectedName];
    baseUrl = baseUrl || (config.proxyTarget && config.proxyTarget.originalBaseUrl)
      || (selected && selected.base_url) || '';
    model = model || parsed.model || '';
    addModels(modelOptions, [model, catalogModels(config)]);
  } else {
    addModels(modelOptions, [catalogModels(config)]);
  }

  return {
    appType: type,
    model,
    modelOptions,
    aliasMap: Object.keys(aliasMap).length ? aliasMap : (provider.aliasMap || {}),
    isOfficial: Object.prototype.hasOwnProperty.call(provider, 'isOfficial')
      ? !!provider.isOfficial
      : !baseUrl,
  };
}

/**
 * Return whether a requested session model is usable by the supplied provider.
 * Missing Codex provider metadata remains permissive; missing/default Claude
 * metadata represents Anthropic login and therefore accepts tiers and
 * claude-* model ids only.
 */
function validationArguments(appTypeOrModel, providerOrModel, maybeModel) {
  const explicitType = String(appTypeOrModel || '').toLowerCase();
  if ((explicitType === 'claude' || explicitType === 'codex') && arguments.length >= 3) {
    return { appType: explicitType, provider: providerOrModel, model: maybeModel };
  }
  // Compatibility overload for hosts that already carry appType on the
  // provider summary: modelValidForProvider(model, provider).
  return {
    appType: String(providerOrModel && providerOrModel.appType || '').toLowerCase(),
    provider: providerOrModel,
    model: appTypeOrModel,
  };
}

function modelValidForProvider(appTypeOrModel, providerOrModel, maybeModel) {
  const { appType, provider, model } = validationArguments(appTypeOrModel, providerOrModel, maybeModel);
  if (model == null || model === '') return true;
  const bare = stripModelSuffix(model);
  const isTier = ALIAS_TIER_REGEX.test(bare);
  const policy = providerPolicy(appType, provider);
  const type = String(appType || (policy && policy.appType) || '').toLowerCase();

  if (type === 'claude' && (!policy || policy.isOfficial)) {
    return isTier || /^claude-/i.test(bare);
  }
  if (!policy) return true;
  if (isTier) {
    if (/^default$/i.test(bare)) return true;
    const entry = policy.aliasMap && policy.aliasMap[bare.toLowerCase()];
    const mapped = entry && typeof entry === 'object' ? entry.model : entry;
    return !!String(mapped || '').trim();
  }

  const served = policy.modelOptions.map(stripModelSuffix).filter(Boolean);
  return served.length === 0 || served.includes(bare);
}

// Stable naming alias for hosts that expose policy as validateModel().
const validateModel = modelValidForProvider;

/**
 * Resolve the model passed to a CLI while rejecting a stale session override.
 * This is the suffix-aware successor to resolveSessionWireModel and preserves
 * its option shape. Every returned concrete model is a bare upstream wire id.
 */
function resolveWireModel(sessionModel, options = {}) {
  const providerModel = options.providerModel !== undefined
    ? options.providerModel
    : (options.model !== undefined ? options.model : null);
  const providerModels = options.providerModels !== undefined
    ? options.providerModels
    : (options.modelOptions || []);
  const skipDefaultModel = !!options.skipDefaultModel;
  const defaultModel = options.defaultModel == null ? null : options.defaultModel;
  const requested = sessionModel ? stripModelSuffix(sessionModel) : '';
  const hasProvider = providerModel !== undefined && providerModel !== null;

  if (!hasProvider) {
    if (requested) return requested;
    if (skipDefaultModel) return null;
    return defaultModel ? stripModelSuffix(defaultModel) : null;
  }

  const served = (Array.isArray(providerModels) ? providerModels : [])
    .map(stripModelSuffix)
    .filter(Boolean);
  if (requested && (ALIAS_TIER_REGEX.test(requested) || served.includes(requested))) {
    return requested;
  }
  return stripModelSuffix(providerModel);
}

module.exports = {
  stripModelSuffix,
  modelValidForProvider,
  validateModel,
  resolveWireModel,
};
