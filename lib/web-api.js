'use strict';

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const express = require('express');

const DEFAULT_HOST = '127.0.0.1';
const STATIC_DIR = path.join(__dirname, '..', 'web', 'public');
// Singular credential field names only. Usage counters such as inputTokens and
// outputTokens are intentionally not secrets and must remain visible.
const SENSITIVE_KEY = /(?:token|secret|password|credential|api[_-]?key|auth|authorization)$/i;

function redactUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = '<redacted>';
    if (parsed.password) parsed.password = '<redacted>';
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) parsed.searchParams.set(key, '<redacted>');
    }
    return parsed.toString();
  } catch (_) { return value; }
}

function redact(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return value == null || value === '' ? value : '<redacted>';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return typeof value === 'string' && /(?:url|endpoint|upstream|original|applied|current)/i.test(key) ? redactUrl(value) : value;
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function exactToken(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function hostHeaderAllowed(host) {
  return /^127\.0\.0\.1(?::\d{1,5})?$/.test(String(host || ''));
}

function loopbackAddress(address) {
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1';
}

function requestGuard(req, res, next) {
  if (!hostHeaderAllowed(req.headers.host) || !loopbackAddress(req.socket.remoteAddress)) {
    return res.status(421).json({ error: 'loopback-host-required' });
  }
  const origin = req.headers.origin;
  if (origin) {
    let parsed;
    try { parsed = new URL(origin); } catch (_) { return res.status(403).json({ error: 'origin-rejected' }); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== req.headers.host || parsed.hostname !== '127.0.0.1') {
      return res.status(403).json({ error: 'origin-rejected' });
    }
  }
  next();
}

function adminGuard(adminToken) {
  return (req, res, next) => {
    if (!exactToken(req.get('x-cpr-admin-token'), adminToken)) return res.status(401).json({ error: 'admin-token-required' });
    next();
  };
}

function providerSummary(store, appType, provider) {
  if (!provider) return null;
  if (typeof store.getProviderSummary === 'function') return redact(store.getProviderSummary(appType, provider.id));
  return redact(provider);
}

function listProviders(store, appType) {
  if (!store || typeof store.listProviders !== 'function') return [];
  return redact(store.listProviders(appType));
}

function profileToView(profile) {
  if (!profile) return null;
  const routes = profile.cli === 'claude'
    ? { main: profile.main || null, sub: profile.subagent || null }
    : {
        main: profile.main || null,
        default: profile.roles && profile.roles.default || null,
        worker: profile.roles && profile.roles.worker || null,
        explorer: profile.roles && profile.roles.explorer || null,
      };
  return { id: profile.id, name: profile.name, cli: profile.cli, enabled: profile.enabled !== false, routes, createdAt: profile.createdAt, updatedAt: profile.updatedAt };
}

function viewToProfile(input, previous = null) {
  const cli = String(input.cli || previous && previous.cli || '').toLowerCase();
  const routes = input.routes || {};
  if (!['claude', 'codex'].includes(cli)) throw Object.assign(new Error('cli must be claude or codex'), { statusCode: 400 });
  const allowed = cli === 'claude' ? new Set(['main', 'sub']) : new Set(['main', 'default', 'worker', 'explorer']);
  const unknown = Object.keys(routes).filter(role => !allowed.has(role));
  if (unknown.length) throw Object.assign(new Error(`unsupported ${cli} route role: ${unknown.join(', ')}`), { statusCode: 400 });
  return cli === 'claude'
    ? { name: input.name, cli, enabled: input.enabled, main: routes.main || null, subagent: routes.sub || null, roles: {} }
    : { name: input.name, cli, enabled: input.enabled, main: routes.main || null, subagent: null,
        roles: Object.fromEntries(['default', 'worker', 'explorer'].filter(role => routes[role]).map(role => [role, routes[role]])) };
}

function usageFilters(query) {
  const filters = Object.fromEntries(['from', 'to', 'cli', 'providerId', 'model', 'sessionId', 'role', 'limit']
    .filter(key => query[key] != null && String(query[key]).length <= 200)
    .map(key => [key, key === 'limit' ? Math.min(Math.max(Number(query[key]) || 100, 1), 1000) : String(query[key])]));
  if (filters.sessionId) { filters.externalSessionId = filters.sessionId; delete filters.sessionId; }
  return filters;
}

async function queryUsage(ledger, filters, summary = false) {
  if (!ledger) return { available: false, reason: 'usage-ledger-not-configured' };
  const cli = filters.cli; const ledgerFilters = { ...filters }; delete ledgerFilters.cli;
  if (cli && typeof ledger.query === 'function') {
    let events = await ledger.query(ledgerFilters);
    const prefix = cli === 'claude' ? 'anthropic-' : cli === 'codex' ? 'openai-' : '';
    if (prefix) events = events.filter(event => String(event.protocol || '').startsWith(prefix));
    if (!summary) return { available: true, data: redact(events) };
    const totals = events.reduce((row, event) => {
      row.events += 1;
      if (!event.tokens) { row.unobservableEvents += 1; return row; }
      row.observedEvents += 1; row.inputTokens += Number(event.tokens.input || 0); row.outputTokens += Number(event.tokens.output || 0);
      row.cacheRead += Number(event.tokens.cacheRead || 0); row.cacheWrite += Number(event.tokens.cacheWrite || 0); row.totalTokens += Number(event.tokens.total || 0);
      return row;
    }, { events: 0, observedEvents: 0, unobservableEvents: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
    return { available: true, data: [totals] };
  }
  const method = summary
    ? (ledger.summary || ledger.getSummary || ledger.rollup)
    : (ledger.query || ledger.list || ledger.getUsage);
  if (typeof method !== 'function') return { available: false, reason: 'usage-ledger-interface-unavailable' };
  return { available: true, data: redact(await method.call(ledger, ledgerFilters)) };
}

async function readSettings(settingsStore) {
  if (!settingsStore) return {};
  if (typeof settingsStore.getAll === 'function') return settingsStore.getAll();
  if (typeof settingsStore.get === 'function') return settingsStore.get();
  return typeof settingsStore === 'object' ? settingsStore : {};
}

async function updateSettings(settingsStore, patch) {
  if (!settingsStore) throw Object.assign(new Error('settings store is unavailable'), { statusCode: 503 });
  if (typeof settingsStore.update === 'function') return settingsStore.update(patch);
  if (typeof settingsStore.setAll === 'function') return settingsStore.setAll(patch);
  throw Object.assign(new Error('settings store is read-only'), { statusCode: 405 });
}

function requireConfirmation(req, expected) {
  if (!req.body || req.body.confirmation !== expected) {
    const error = new Error(`confirmation must equal ${expected}`);
    error.statusCode = 400;
    error.code = 'CONFIRMATION_REQUIRED';
    throw error;
  }
}

function requireDirectCli(manager, rawCli) {
  if (!manager) throw Object.assign(new Error('direct CLI config manager is unavailable'), { statusCode: 503 });
  const cli = String(rawCli || '').toLowerCase();
  if (!['claude', 'codex'].includes(cli)) throw Object.assign(new Error('cli must be claude or codex'), { statusCode: 400 });
  return cli;
}

function ccSwitchStatusView(error, fallback = {}) {
  if (!error || error.code !== 'SQLITE_UNAVAILABLE') throw error;
  return {
    ...fallback,
    available: false,
    supported: false,
    takeover: fallback.takeover || 'unavailable',
    error: error.code,
    message: error.message,
    repair: error.repair,
    issues: ['sqlite-runtime-unavailable'],
  };
}

function requireDirectProfile(profiles, cli, rawProfileId) {
  const profileId = String(rawProfileId || '');
  if (!profileId) throw Object.assign(new Error('profile is required'), { statusCode: 400 });
  const profile = profiles && typeof profiles.get === 'function' ? profiles.get(profileId) : null;
  if (!profile) throw Object.assign(new Error('route profile not found'), { statusCode: 404 });
  if (profile.cli !== cli) throw Object.assign(new Error(`route profile is for ${profile.cli}, not ${cli}`), { statusCode: 400 });
  return profileId;
}

function ccSelection(body = {}, requireAllConfirmation = false) {
  return {
    selectedProviders: Array.isArray(body.selectedProviders) ? body.selectedProviders : undefined,
    allProviders: body.allProviders === true,
    ...(requireAllConfirmation ? { confirmAllProviders: body.allProvidersConfirmation } : {}),
  };
}

function createWebApp(options = {}) {
  const app = express();
  const adminToken = options.adminToken || crypto.randomBytes(32).toString('base64url');
  const store = options.store;
  const profiles = options.routeProfiles;
  const ccSwitch = options.ccSwitch;
  const usageLedger = options.usageLedger;
  const settingsStore = options.settings;
  const directCliConfig = options.directCliConfig;
  const ccOptions = { ...(options.ccSwitchOptions || {}) };
  const proxyBaseUrl = ccOptions.proxyBaseUrl || options.proxyBaseUrl;

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Cache-Control': req.path.startsWith('/api/') ? 'no-store' : 'no-cache',
    });
    next();
  });
  app.use(requestGuard);
  app.use(express.json({ limit: '256kb', strict: true }));

  app.get('/health', (_req, res) => res.json({ ok: true, product: 'cli-provider-router-web', pid: process.pid }));
  app.get('/api/bootstrap', (req, res) => res.json({ adminToken, apiBase: '/api', capabilities: {
    providers: !!store, routeProfiles: !!profiles, ccSwitch: !!ccSwitch, directCliConfig: !!directCliConfig,
    usage: !!usageLedger, settings: !!settingsStore,
  } }));
  app.use('/api', adminGuard(adminToken));

  app.get('/api/dashboard', asyncRoute(async (_req, res) => {
    const [ccStatus, directClaude, directCodex, usage] = await Promise.all([
      ccSwitch && ccOptions.dbPath ? Promise.resolve().then(() => ccSwitch.status(ccOptions)).catch(error => (
        error.code === 'SQLITE_UNAVAILABLE' ? ccSwitchStatusView(error) : { available: false, error: error.message }
      )) : null,
      directCliConfig ? Promise.resolve(directCliConfig.status({ cli: 'claude' })).catch(error => ({ available: false, error: error.message })) : null,
      directCliConfig ? Promise.resolve(directCliConfig.status({ cli: 'codex' })).catch(error => ({ available: false, error: error.message })) : null,
      queryUsage(usageLedger, {}, true),
    ]);
    const routeList = profiles && typeof profiles.list === 'function' ? profiles.list() : [];
    res.json({
      providers: { claude: listProviders(store, 'claude').length, codex: listProviders(store, 'codex').length },
      routeProfiles: routeList.length,
      ccSwitch: redact(ccStatus || { available: false }),
      directCliConfig: redact({ claude: directClaude || { available: false }, codex: directCodex || { available: false } }),
      usage,
    });
  }));

  app.get('/api/providers', (req, res) => res.json({ providers: listProviders(store, req.query.appType) }));
  app.post('/api/providers', (req, res) => {
    if (!store || typeof store.createProvider !== 'function') return res.status(503).json({ error: 'provider-store-unavailable' });
    const provider = store.createProvider(req.body || {});
    res.status(201).json({ provider: providerSummary(store, provider.appType, provider) });
  });
  app.patch('/api/providers/:appType/:id', (req, res) => {
    if (!store || typeof store.updateProvider !== 'function') return res.status(503).json({ error: 'provider-store-unavailable' });
    const provider = store.updateProvider(req.params.appType, req.params.id, req.body || {});
    res.json({ provider: providerSummary(store, req.params.appType, provider) });
  });
  app.delete('/api/providers/:appType/:id', (req, res) => {
    if (!store || typeof store.deleteProvider !== 'function') return res.status(503).json({ error: 'provider-store-unavailable' });
    res.json({ deleted: !!store.deleteProvider(req.params.appType, req.params.id) });
  });

  app.get('/api/ccswitch/detect', (_req, res) => {
    if (!ccSwitch || !ccOptions.dbPath) return res.json({ found: false, supported: false, issues: ['not-configured'] });
    try { return res.json(redact(ccSwitch.discover(ccOptions))); }
    catch (error) { return res.json(redact(ccSwitchStatusView(error, { found: true }))); }
  });
  app.get('/api/ccswitch/status', (_req, res) => {
    if (!ccSwitch || !ccOptions.dbPath) return res.json({ takeover: 'unavailable', managed: false });
    try { return res.json(redact(ccSwitch.status(ccOptions))); }
    catch (error) { return res.json(redact(ccSwitchStatusView(error, { managed: false }))); }
  });
  app.post('/api/ccswitch/preview', (req, res) => {
    if (!ccSwitch || !ccOptions.dbPath || !proxyBaseUrl) return res.status(503).json({ error: 'ccswitch-takeover-unavailable' });
    res.json(redact(ccSwitch.preview({
      ...ccOptions,
      proxyBaseUrl,
      snapshotId: req.body && req.body.snapshotId,
      ...ccSelection(req.body || {}),
    })));
  });
  app.post('/api/ccswitch/snapshot', asyncRoute(async (req, res) => {
    if (!ccSwitch || !ccOptions.dbPath) return res.status(503).json({ error: 'ccswitch-takeover-unavailable' });
    requireConfirmation(req, 'CREATE SNAPSHOT');
    res.status(201).json(redact(await ccSwitch.snapshot(ccOptions)));
  }));
  app.post('/api/ccswitch/apply', asyncRoute(async (req, res) => {
    if (!ccSwitch || !ccOptions.dbPath || !proxyBaseUrl) return res.status(503).json({ error: 'ccswitch-takeover-unavailable' });
    requireConfirmation(req, 'APPLY TAKEOVER');
    res.json(redact(await ccSwitch.apply({
      ...ccOptions,
      proxyBaseUrl,
      snapshotId: req.body.snapshotId,
      ...ccSelection(req.body, true),
    })));
  }));
  app.post('/api/ccswitch/restore', asyncRoute(async (req, res) => {
    if (!ccSwitch || !ccOptions.dbPath) return res.status(503).json({ error: 'ccswitch-takeover-unavailable' });
    const force = !!req.body.force;
    requireConfirmation(req, force ? 'FORCE RESTORE' : 'RESTORE');
    res.json(redact(await ccSwitch.restore({ ...ccOptions, force })));
  }));

  // Native CLI configuration takeover is deliberately separate from the
  // CC-Switch database workflow and remains available when CC-Switch is absent.
  app.get('/api/cli-config/detect', asyncRoute(async (req, res) => {
    const cli = requireDirectCli(directCliConfig, req.query.cli);
    res.json(redact(await directCliConfig.detect({ cli })));
  }));
  app.get('/api/cli-config/status', asyncRoute(async (req, res) => {
    const cli = requireDirectCli(directCliConfig, req.query.cli);
    res.json(redact(await directCliConfig.status({ cli })));
  }));
  app.post('/api/cli-config/preview', asyncRoute(async (req, res) => {
    const cli = requireDirectCli(directCliConfig, req.body && req.body.cli);
    const profileId = requireDirectProfile(profiles, cli, req.body && (req.body.profileId || req.body.profile));
    res.json(redact(await directCliConfig.preview({ cli, profileId })));
  }));
  app.post('/api/cli-config/snapshot', asyncRoute(async (req, res) => {
    const cli = requireDirectCli(directCliConfig, req.body && req.body.cli);
    const profileId = requireDirectProfile(profiles, cli, req.body && (req.body.profileId || req.body.profile));
    requireConfirmation(req, 'CREATE CLI SNAPSHOT');
    res.status(201).json(redact(await directCliConfig.snapshot({ cli, profileId })));
  }));
  app.post('/api/cli-config/apply', asyncRoute(async (req, res) => {
    const cli = requireDirectCli(directCliConfig, req.body && req.body.cli);
    const profileId = requireDirectProfile(profiles, cli, req.body && (req.body.profileId || req.body.profile));
    requireConfirmation(req, 'APPLY CLI TAKEOVER');
    res.json(redact(await directCliConfig.apply({ cli, profileId, snapshotId: req.body.snapshotId || req.body.snapshot })));
  }));
  app.post('/api/cli-config/restore', asyncRoute(async (req, res) => {
    const cli = requireDirectCli(directCliConfig, req.body && req.body.cli);
    const force = !!req.body.force;
    requireConfirmation(req, force ? 'FORCE RESTORE CLI CONFIG' : 'RESTORE CLI CONFIG');
    res.json(redact(await directCliConfig.restore({ cli, snapshotId: req.body.snapshotId || req.body.snapshot, force })));
  }));

  app.get('/api/routes', (_req, res) => res.json({ profiles: profiles && typeof profiles.list === 'function' ? profiles.list().map(profileToView) : [] }));
  app.post('/api/routes', (req, res) => {
    if (!profiles || typeof profiles.create !== 'function') return res.status(503).json({ error: 'route-profile-store-unavailable' });
    res.status(201).json({ profile: profileToView(profiles.create(viewToProfile(req.body || {}))) });
  });
  app.patch('/api/routes/:id', (req, res) => {
    if (!profiles || typeof profiles.update !== 'function') return res.status(503).json({ error: 'route-profile-store-unavailable' });
    const previous = typeof profiles.get === 'function' ? profiles.get(req.params.id) : null;
    if (!previous) return res.status(404).json({ error: 'route-profile-not-found' });
    const priorView = profileToView(previous);
    const merged = { ...priorView, ...req.body, routes: { ...priorView.routes, ...(req.body.routes || {}) } };
    res.json({ profile: profileToView(profiles.update(req.params.id, viewToProfile(merged, previous))) });
  });
  app.delete('/api/routes/:id', (req, res) => {
    if (!profiles || typeof profiles.remove !== 'function') return res.status(503).json({ error: 'route-profile-store-unavailable' });
    res.json({ deleted: !!profiles.remove(req.params.id) });
  });

  app.get('/api/usage', asyncRoute(async (req, res) => res.json(await queryUsage(usageLedger, usageFilters(req.query), false))));
  app.get('/api/usage/summary', asyncRoute(async (req, res) => res.json(await queryUsage(usageLedger, usageFilters(req.query), true))));
  app.get('/api/settings', asyncRoute(async (_req, res) => res.json({ settings: redact(await readSettings(settingsStore)) })));
  app.patch('/api/settings', asyncRoute(async (req, res) => res.json({ settings: redact(await updateSettings(settingsStore, req.body || {})) })));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'api-not-found' }));

  app.use(express.static(options.staticDir || STATIC_DIR, { index: false, etag: true, fallthrough: true }));
  app.get('*', (_req, res) => res.sendFile(path.join(options.staticDir || STATIC_DIR, 'index.html')));

  app.use((error, _req, res, _next) => {
    const badRequestCodes = new Set([
      'ALL_PROVIDERS_CONFIRMATION_REQUIRED', 'CONFIRMATION_REQUIRED',
      'INVALID_PROVIDER_SELECTION', 'PROVIDER_SELECTION_REQUIRED',
    ]);
    const conflictCodes = new Set([
      'ACTIVE_TAKEOVER', 'CONFIG_DRIFT', 'DATABASE_IDENTITY_MISMATCH',
      'DATABASE_MISMATCH', 'DOUBLE_PROXY', 'RESTORE_FORCE_REQUIRED',
      'SNAPSHOT_DATABASE_MISMATCH', 'SNAPSHOT_RECOVERY_TARGET_MISMATCH',
    ]);
    const unavailableCodes = new Set([
      'PROXY_HEALTH_FAILED', 'PROXY_HEALTH_NONCE_MISMATCH',
      'PROXY_HEALTH_NONCE_REQUIRED', 'SQLITE_UNAVAILABLE',
    ]);
    const sqliteUnavailable = error.code === 'SQLITE_UNAVAILABLE';
    const statusCode = Number(error.statusCode || error.status)
      || (badRequestCodes.has(error.code) ? 400
        : conflictCodes.has(error.code) ? 409
          : unavailableCodes.has(error.code) ? 503 : 500);
    const safeLifecycleError = badRequestCodes.has(error.code)
      || conflictCodes.has(error.code) || unavailableCodes.has(error.code);
    const body = {
      error: error.code || (statusCode >= 500 ? 'internal-error' : 'request-error'),
      message: statusCode >= 500 && !safeLifecycleError ? 'Request failed' : error.message,
    };
    if (error.code === 'CONFIG_DRIFT') body.conflicts = redact(error.conflicts || []);
    if (sqliteUnavailable) body.repair = error.repair;
    res.status(statusCode).json(body);
  });

  app.locals.cprAdminToken = adminToken;
  return app;
}

function createWebServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  if (host !== DEFAULT_HOST) throw new Error('CPR Web may only bind to 127.0.0.1');
  const app = createWebApp(options);
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(options.port) || 0, host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      resolve({
        app, server, host, port: address.port, adminToken: app.locals.cprAdminToken,
        url: `http://${host}:${address.port}`,
        close: () => new Promise((done, fail) => server.close(error => error ? fail(error) : done())),
      });
    });
  });
}

module.exports = { createWebApp, createWebServer, profileToView, redact, viewToProfile };
