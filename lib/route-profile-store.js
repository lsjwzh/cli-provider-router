'use strict';

const crypto = require('crypto');
const { createCprPaths, ensureCprPaths } = require('./paths');
const { createDurableStore } = require('./durable-store');

const ROUTE_PROFILE_SCHEMA_VERSION = 1;

function cleanEndpoint(value, label) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const providerId = String(value.providerId || '').trim();
  const model = String(value.model || '').trim();
  if (!providerId && !model) return null;
  if (!providerId) throw new Error(`${label}.providerId is required when a model is set`);
  return { providerId, ...(model ? { model } : {}) };
}

function normalizeRouteProfile(input, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('route profile must be an object');
  const now = Date.now();
  const name = String(input.name == null ? previous.name || '' : input.name).trim();
  const cli = String(input.cli == null ? previous.cli || '' : input.cli).trim().toLowerCase();
  if (!name) throw new Error('route profile name is required');
  if (!['claude', 'codex'].includes(cli)) throw new Error('route profile cli must be claude or codex');
  const sourceRoles = input.roles == null ? (previous.roles || {}) : input.roles;
  if (!sourceRoles || typeof sourceRoles !== 'object' || Array.isArray(sourceRoles)) throw new Error('route profile roles must be an object');
  const roles = {};
  for (const [role, endpoint] of Object.entries(sourceRoles)) {
    const key = String(role).trim();
    if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(key)) throw new Error(`invalid route role: ${role}`);
    const clean = cleanEndpoint(endpoint, `roles.${key}`);
    if (clean) roles[key] = clean;
  }
  return {
    id: String(previous.id || input.id || crypto.randomUUID()),
    name,
    cli,
    enabled: input.enabled == null ? previous.enabled !== false : !!input.enabled,
    main: cleanEndpoint(input.main == null ? previous.main : input.main, 'main'),
    subagent: cleanEndpoint(input.subagent == null ? previous.subagent : input.subagent, 'subagent'),
    roles,
    metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? { ...input.metadata }
      : { ...(previous.metadata || {}) },
    createdAt: previous.createdAt || now,
    updatedAt: now,
  };
}

function createRouteProfileStore(options = {}) {
  const paths = ensureCprPaths(options.paths || createCprPaths({ home: options.cprHome }));
  const dataFile = options.dataFile || paths.routeProfilesFile;
  const validate = typeof options.validateProfile === 'function' ? options.validateProfile : profile => profile;

  // Durable layer: fail-closed reads, schema envelope, rolling backups and a
  // cross-process lock so Web-service and CLI writers cannot lose updates.
  // Legacy documents (bare array or { version, profiles }) migrate on write.
  const durable = createDurableStore({
    file: dataFile,
    schemaName: 'cpr.route-profiles',
    schemaVersion: ROUTE_PROFILE_SCHEMA_VERSION,
    payloadKey: 'profiles',
    defaultPayload: [],
    owner: 'cpr:route-profiles',
    migrateLegacy(raw) {
      if (raw === null) return [];
      if (Array.isArray(raw)) return raw;
      if (raw && typeof raw === 'object' && Array.isArray(raw.profiles)) return raw.profiles;
      return undefined;
    },
  });

  function list() { return durable.load().payload.map(p => ({ ...p })); }
  function get(id) { return list().find(p => p.id === id) || null; }
  function create(input) {
    const profile = validate(normalizeRouteProfile(input));
    durable.mutate(profiles => ({ next: [...profiles, profile], result: null }));
    return { ...profile };
  }
  function update(id, patch) {
    return durable.mutate(profiles => {
      const index = profiles.findIndex(p => p.id === id);
      if (index < 0) throw new Error('route profile not found');
      profiles[index] = validate(normalizeRouteProfile({ ...profiles[index], ...patch, id }, profiles[index]));
      return { next: profiles, result: { ...profiles[index] } };
    }).result;
  }
  function remove(id) {
    const { changed } = durable.mutate(profiles => {
      const next = profiles.filter(p => p.id !== id);
      return next.length === profiles.length ? null : { next, result: true };
    });
    return changed;
  }
  function resolve(cli, profileId) {
    return list().find(p => p.enabled !== false && p.cli === cli && (!profileId || p.id === profileId)) || null;
  }

  function referencesProvider(appType, providerId) {
    return list().filter(profile => profile.cli === appType && [
      profile.main,
      profile.subagent,
      ...Object.values(profile.roles || {}),
    ].filter(Boolean).some(endpoint => endpoint.providerId === providerId));
  }

  return { list, get, create, update, remove, resolve, referencesProvider, _dataFile: dataFile, _paths: paths };
}

module.exports = { ROUTE_PROFILE_SCHEMA_VERSION, normalizeRouteProfile, createRouteProfileStore };
