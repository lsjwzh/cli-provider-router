'use strict';

const crypto = require('crypto');
const path = require('path');
const { createCprPaths, ensureCprPaths } = require('../paths');
const { readJson, writeJsonAtomic } = require('../atomic-json');

const HOP_CREDENTIAL_SCHEMA_VERSION = 1;
const DEFAULT_HOP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ROLE_KINDS = new Set(['main', 'sub', 'aux']);
const BUILTIN_AGENT_ROLES = new Set(['default', 'worker', 'explorer']);

function cleanPart(value, label, allowEmpty = false) {
  const part = String(value == null ? '' : value).trim();
  if (!part && allowEmpty) return '';
  if (!part || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(part)) {
    throw new Error(`invalid hop credential ${label}`);
  }
  return part;
}

function normalizeRole(input = {}) {
  const raw = String(input.routeName || input.agentRole || input.role || 'main').trim().toLowerCase();
  if (raw === 'main') return { valid: true, roleKind: 'main', agentRole: '', routeName: 'main' };
  if (raw === 'aux') return { valid: true, roleKind: 'aux', agentRole: '', routeName: 'aux' };
  if (raw === 'sub') return { valid: true, roleKind: 'sub', agentRole: 'default', routeName: 'default' };
  if (/^[a-z][a-z0-9_-]{0,63}$/.test(raw)) {
    return {
      valid: true,
      roleKind: 'sub',
      agentRole: BUILTIN_AGENT_ROLES.has(raw) ? raw : 'custom',
      routeName: raw,
    };
  }
  return {
    valid: false,
    roleKind: 'sub',
    agentRole: 'custom',
    routeName: '',
    requestedRole: raw,
  };
}

function normalizeRoute(input = {}) {
  const role = normalizeRole(input);
  if (!role.valid) throw new Error('invalid hop credential routeName');
  const roleKind = input.roleKind == null ? role.roleKind : cleanPart(input.roleKind, 'roleKind').toLowerCase();
  if (!ROLE_KINDS.has(roleKind)) throw new Error('hop credential roleKind must be main, sub, or aux');
  return {
    cli: cleanPart(input.cli, 'cli').toLowerCase(),
    providerId: cleanPart(input.providerId, 'providerId'),
    sessionId: cleanPart(input.sessionId, 'sessionId'),
    roleKind,
    agentRole: roleKind === 'sub' ? (input.agentRole ? cleanPart(input.agentRole, 'agentRole').toLowerCase() : role.agentRole) : '',
    routeName: roleKind === 'sub' ? (input.routeName ? cleanPart(input.routeName, 'routeName').toLowerCase() : role.routeName) : roleKind,
  };
}

function routeKey(input) {
  const route = normalizeRoute(input);
  return [route.cli, route.providerId, route.sessionId, route.roleKind, route.agentRole, route.routeName]
    .map(value => encodeURIComponent(value)).join('|');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function exactHash(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function bearerToken(headers = {}) {
  const raw = String(headers.authorization || headers.Authorization || '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  if (match) return match[1].trim();
  return String(headers['x-api-key'] || headers['X-Api-Key'] || '').trim();
}

function createHopCredentialStore(options = {}) {
  // A host-owned credential file is a complete storage injection. Avoid
  // touching CPR_HOME merely to compute a path that will not be used.
  const paths = options.paths
    ? ensureCprPaths(options.paths)
    : (options.dataFile ? null : ensureCprPaths(createCprPaths({ home: options.cprHome })));
  const dataFile = options.dataFile || path.join(paths.runDir, 'hop-credentials.json');
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const defaultTtlMs = Number(options.ttlMs || DEFAULT_HOP_TTL_MS);

  function load() {
    const document = readJson(dataFile, null);
    if (!document) return { version: HOP_CREDENTIAL_SCHEMA_VERSION, credentials: [] };
    if (document.version !== HOP_CREDENTIAL_SCHEMA_VERSION || !Array.isArray(document.credentials)) {
      throw new Error('hop credential store has an unsupported schema');
    }
    return document;
  }

  function save(credentials) {
    writeJsonAtomic(dataFile, { version: HOP_CREDENTIAL_SCHEMA_VERSION, credentials });
  }

  function issue(input = {}) {
    const result = issueBundle([input], input);
    return result.credentials[0];
  }

  // Issue one opaque token for a closed set of allowed routes. Claude's
  // in-process subagents reuse the main client's Authorization header, so a
  // bundle lets that one token authenticate both the main route and only the
  // explicitly planned subagent routes. The clear token is returned once and
  // never persisted; every stored route contains only its hash.
  function issueBundle(inputs, bundleOptions = {}) {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 256) {
      throw new Error('hop credential bundle must contain 1 to 256 routes');
    }
    const routes = inputs.map(normalizeRoute);
    const keys = routes.map(routeKey);
    if (new Set(keys).size !== keys.length) throw new Error('hop credential bundle contains duplicate routes');
    const issuedAt = now();
    const expiresAt = bundleOptions.expiresAt == null ? issuedAt + defaultTtlMs : Number(bundleOptions.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= issuedAt) throw new Error('hop credential expiresAt must be in the future');
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = tokenHash(token);
    const records = routes.map((route, index) => ({
      id: crypto.randomUUID(),
      bundleId: bundleOptions.bundleId || crypto.randomUUID(),
      bundleIndex: index,
      ...route,
      routeKey: keys[index],
      tokenHash: hash,
      issuedAt,
      expiresAt,
      revokedAt: null,
    }));
    const bundleId = records[0].bundleId;
    records.forEach(record => { record.bundleId = bundleId; });
    const document = load();
    const credentials = document.credentials.map(existing => (
      keys.includes(existing.routeKey) && !existing.revokedAt
        ? { ...existing, revokedAt: issuedAt, revokeReason: 'rotated' }
        : existing
    ));
    credentials.push(...records);
    save(credentials);
    return {
      bundleId,
      token,
      issuedAt,
      expiresAt,
      credentials: records.map(({ tokenHash: _secret, ...record }) => ({ ...record, token })),
    };
  }

  function verify(input = {}, token = '') {
    let route;
    try { route = normalizeRoute(input); }
    catch (error) { return { ok: false, managed: false, reason: 'invalid-route', error: error.message }; }
    const key = routeKey(route);
    const matches = load().credentials.filter(record => record.routeKey === key).sort((a, b) => b.issuedAt - a.issuedAt);
    if (!matches.length) return { ok: false, managed: false, reason: 'unmanaged-route', ...route };
    const active = matches.find(record => !record.revokedAt) || matches[0];
    if (active.revokedAt) return { ok: false, managed: true, reason: 'revoked', credentialId: active.id, ...route };
    if (Number(active.expiresAt) <= now()) return { ok: false, managed: true, reason: 'expired', credentialId: active.id, ...route };
    if (!token) return { ok: false, managed: true, reason: 'missing', credentialId: active.id, ...route };
    const ok = exactHash(tokenHash(token), active.tokenHash);
    return { ok, managed: true, reason: ok ? 'valid' : 'mismatch', credentialId: active.id, expiresAt: active.expiresAt, ...route };
  }

  function revoke(input = {}, reason = 'revoked') {
    const document = load();
    const ids = new Set((Array.isArray(input.ids) ? input.ids : input.id ? [input.id] : []).map(String));
    const sessionId = input.sessionId == null ? '' : String(input.sessionId);
    const revokedAt = now();
    let count = 0;
    const credentials = document.credentials.map(record => {
      const selected = !record.revokedAt && (ids.has(record.id) || (!ids.size && sessionId && record.sessionId === sessionId));
      if (!selected) return record;
      count++;
      return { ...record, revokedAt, revokeReason: String(reason || 'revoked') };
    });
    if (count) save(credentials);
    return { revoked: count, revokedAt };
  }

  function purge(input = {}) {
    const cutoff = Number(input.before == null ? now() : input.before);
    const document = load();
    const next = document.credentials.filter(record => !(record.revokedAt && record.revokedAt <= cutoff));
    if (next.length !== document.credentials.length) save(next);
    return { removed: document.credentials.length - next.length };
  }

  function list(options = {}) {
    const includeRevoked = !!options.includeRevoked;
    return load().credentials.filter(record => includeRevoked || !record.revokedAt).map(({ tokenHash: _secret, ...record }) => ({
      ...record,
      expired: Number(record.expiresAt) <= now(),
    }));
  }

  return { issue, issueBundle, verify, revoke, purge, list, dataFile, paths };
}

function authorizeManagedRequest(req, context, store, options = {}) {
  const token = bearerToken(req && req.headers || {});
  const result = store.verify(context, token);
  const requireManaged = options.requireManaged === true || String(context.sessionId || '').startsWith('direct-');
  if (!result.managed && !requireManaged) return { ok: true, managed: false, reason: 'legacy-unmanaged-route', ...normalizeRole(context) };
  return result;
}

module.exports = {
  HOP_CREDENTIAL_SCHEMA_VERSION,
  DEFAULT_HOP_TTL_MS,
  normalizeRole,
  normalizeRoute,
  bearerToken,
  createHopCredentialStore,
  authorizeManagedRequest,
};
