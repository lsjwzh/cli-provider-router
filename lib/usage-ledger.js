'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createCprPaths, ensureCprPaths, FILE_MODE } = require('./paths');
const { readJson, writeJsonAtomic, removeFile } = require('./atomic-json');

const USAGE_SCHEMA_VERSION = 2;
const USAGE_STORAGE_CONTRACT_VERSION = 1;
const DEFAULT_RETENTION_DAYS = 90;
const ROLE_KINDS = new Set(['main', 'sub', 'aux']);
const AGENT_ROLES = new Set(['default', 'worker', 'explorer', 'custom']);
const SOURCES = new Set(['exact', 'reconciled']);
const STATUSES = new Set(['success', 'error', 'unobservable']);
const COVERAGE = new Set(['observed', 'unobservable']);

function number(value, label) {
  const n = Number(value == null ? 0 : value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative number`);
  return n;
}

function normalizeTokens(tokens, status, coverage) {
  if (coverage === 'unobservable' || status === 'unobservable') {
    if (tokens != null) throw new Error('unobservable usage must not contain token counts');
    return null;
  }
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) throw new Error('tokens are required for observable usage');
  const normalized = {
    input: number(tokens.input != null ? tokens.input : tokens.inputTokens, 'tokens.input'),
    output: number(tokens.output != null ? tokens.output : tokens.outputTokens, 'tokens.output'),
    cacheRead: number(tokens.cacheRead, 'tokens.cacheRead'),
    cacheWrite: number(tokens.cacheWrite, 'tokens.cacheWrite'),
  };
  normalized.total = normalized.input + normalized.output;
  return normalized;
}

function normalizeUsageEvent(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('usage event must be an object');
  const occurredAt = Number(input.occurredAt || input.timestamp || Date.now());
  if (!Number.isFinite(occurredAt) || occurredAt <= 0) throw new Error('occurredAt must be a timestamp');
  const eventId = String(input.eventId || (options.generateId === false ? '' : crypto.randomUUID())).trim();
  if (!eventId) throw new Error('eventId is required');
  const roleKind = String(input.roleKind || input.role || '').trim();
  const source = String(input.source || 'exact').trim();
  const status = String(input.status || 'success').trim();
  const inferredCoverage = input.tokens || input.usage ? 'observed' : 'unobservable';
  const coverage = String(input.coverage || (status === 'unobservable' ? 'unobservable' : inferredCoverage)).trim();
  if (!ROLE_KINDS.has(roleKind)) throw new Error('roleKind must be main, sub, or aux');
  if (!SOURCES.has(source)) throw new Error('source must be exact or reconciled');
  if (!STATUSES.has(status)) throw new Error('status must be success, error, or unobservable');
  if (!COVERAGE.has(coverage)) throw new Error('coverage must be observed or unobservable');
  let agentRole = String(input.agentRole || '').trim().toLowerCase();
  if (roleKind === 'sub') {
    if (!agentRole) agentRole = 'default';
    if (!AGENT_ROLES.has(agentRole)) throw new Error('agentRole must be default, worker, explorer, or custom');
  } else {
    agentRole = '';
  }
  let routeName = roleKind === 'sub' ? String(input.routeName || (agentRole === 'custom' ? 'custom' : agentRole)).trim().toLowerCase() : roleKind;
  if (roleKind === 'sub' && !/^[a-z][a-z0-9_-]{0,63}$/.test(routeName)) throw new Error('routeName must be a valid agent route');
  const providerId = String(input.providerId || '').trim();
  if (!providerId) throw new Error('providerId is required');
  const externalSessionId = String(input.externalSessionId || input.sessionId || '').trim();
  if (!externalSessionId) throw new Error('externalSessionId is required');
  const protocol = String(input.protocol || '').trim();
  if (!protocol) throw new Error('protocol is required');
  const tokens = normalizeTokens(input.tokens || input.usage, status, coverage);
  return {
    version: USAGE_SCHEMA_VERSION,
    eventId,
    occurredAt,
    externalSessionId,
    role: roleKind,
    roleKind,
    agentRole: agentRole || null,
    routeName,
    providerId,
    providerName: String(input.providerName || '').trim(),
    model: String(input.model || '').trim(),
    protocol,
    tokens,
    latencyMs: number(input.latencyMs, 'latencyMs'),
    status,
    coverage,
    ...(input.statusCode == null ? {} : { statusCode: number(input.statusCode, 'statusCode') }),
    source,
    ...(input.errorCode ? { errorCode: String(input.errorCode).slice(0, 128) } : {}),
    ...(input.fallbackReason ? { fallbackReason: String(input.fallbackReason).slice(0, 128) } : {}),
  };
}

function dateKey(timestamp) { return new Date(timestamp).toISOString().slice(0, 10); }

function parseBoundary(value, end = false) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const parsed = Date.parse(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
    if (!Number.isFinite(parsed)) throw new Error(`invalid date: ${value}`);
    return parsed;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid date: ${value}`);
  return parsed;
}

function eventMatches(event, filters = {}) {
  const from = parseBoundary(filters.from);
  const to = parseBoundary(filters.to, true);
  if (from != null && event.occurredAt < from) return false;
  if (to != null && event.occurredAt > to) return false;
  const mappings = [
    ['role', 'roleKind'], ['roleKind', 'roleKind'], ['agentRole', 'agentRole'], ['routeName', 'routeName'],
    ['providerId', 'providerId'], ['provider', 'providerId'], ['model', 'model'],
    ['externalSessionId', 'externalSessionId'], ['session', 'externalSessionId'],
    ['protocol', 'protocol'], ['source', 'source'], ['status', 'status'], ['coverage', 'coverage'],
  ];
  return mappings.every(([filterKey, eventKey]) => filters[filterKey] == null || String(filters[filterKey]) === String(event[eventKey]));
}

function groupValue(event, key) {
  if (key === 'date') return dateKey(event.occurredAt);
  if (key === 'provider') return event.providerId || '';
  if (key === 'session') return event.externalSessionId || '';
  if (key === 'role') return event.roleKind || event.role || '';
  return event[key] || '';
}

function createUsageLedger(options = {}) {
  const paths = ensureCprPaths(options.paths || createCprPaths({ home: options.cprHome }));
  const usageDir = options.usageDir || paths.usageDir;
  const policyFile = options.policyFile || paths.usagePolicyFile;
  fs.mkdirSync(usageDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(usageDir, 0o700); } catch (_) {}
  const lockFile = path.join(usageDir, '.ledger.lock');
  const externalStorage = options.storage || null;
  if (externalStorage && (typeof externalStorage.append !== 'function' || typeof externalStorage.query !== 'function')) {
    throw new Error('usage storage must implement append(event) and query(filters)');
  }
  let eventIds = null;

  function shardFiles() {
    return fs.readdirSync(usageDir)
      .filter(name => /^events-\d{4}-\d{2}-\d{2}\.(?:jsonl|json)$/.test(name))
      .sort()
      .map(name => path.join(usageDir, name));
  }

  function shardFile(timestamp) { return path.join(usageDir, `events-${dateKey(timestamp)}.jsonl`); }

  function readShard(file) {
    if (file.endsWith('.jsonl')) {
      const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const events = [];
      source.split('\n').forEach((line, index) => {
        if (!line.trim()) return;
        try { events.push(JSON.parse(line)); }
        catch (_) { throw new Error(`usage shard is unreadable at ${file}:${index + 1}`); }
      });
      return events;
    }
    const value = readJson(file, null);
    if (value === null && fs.existsSync(file)) throw new Error(`usage shard is unreadable: ${file}`);
    if (value === null) return [];
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.events)) return value.events;
    throw new Error(`usage shard has an invalid schema: ${file}`);
  }

  function ensureEventIndex() {
    if (eventIds) return eventIds;
    eventIds = new Set();
    for (const file of shardFiles()) {
      for (const event of readShard(file)) if (event && event.eventId) eventIds.add(String(event.eventId));
    }
    return eventIds;
  }

  function acquireLock() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { return fs.openSync(lockFile, 'wx', FILE_MODE); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try { if (Date.now() - fs.statSync(lockFile).mtimeMs > 30000) removeFile(lockFile); } catch (_) {}
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    throw new Error('usage ledger is busy');
  }

  function withLock(fn) {
    const fd = acquireLock();
    try { return fn(); }
    finally { try { fs.closeSync(fd); } catch (_) {} removeFile(lockFile); }
  }

  function appendJsonLine(file, value) {
    const fd = fs.openSync(file, 'a', FILE_MODE);
    try {
      fs.writeSync(fd, `${JSON.stringify(value)}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try { fs.chmodSync(file, FILE_MODE); } catch (_) {}
  }

  function append(input) {
    const event = normalizeUsageEvent(input);
    if (externalStorage) {
      const result = externalStorage.append(event);
      const inserted = typeof result === 'boolean' ? result : !(result && result.inserted === false);
      return { inserted, event };
    }
    return withLock(() => {
      const index = ensureEventIndex();
      if (index.has(event.eventId)) return { inserted: false, event };
      appendJsonLine(shardFile(event.occurredAt), event);
      index.add(event.eventId);
      return { inserted: true, event };
    });
  }

  function recordProxyUsage(info = {}) {
    return append({
      eventId: info.eventId,
      occurredAt: info.occurredAt || Date.now(),
      externalSessionId: info.externalSessionId || info.sessionId,
      role: info.role,
      roleKind: info.roleKind,
      agentRole: info.agentRole,
      routeName: info.routeName,
      providerId: info.providerId,
      providerName: info.providerName,
      model: info.model,
      protocol: info.protocol,
      tokens: info.usage || info.tokens,
      latencyMs: info.latencyMs,
      status: info.status || 'success',
      statusCode: info.statusCode,
      coverage: info.coverage,
      source: info.source || 'exact',
      errorCode: info.errorCode,
      fallbackReason: info.fallbackReason,
    });
  }

  function recordUnobservable(input = {}) {
    return append({ ...input, status: input.status || 'unobservable', coverage: 'unobservable', tokens: null, source: input.source || 'exact' });
  }

  function query(filters = {}) {
    const source = externalStorage ? externalStorage.query(filters) : shardFiles().flatMap(readShard);
    if (!Array.isArray(source)) throw new Error('usage storage query must return an array');
    const events = source.filter(event => eventMatches(event, filters));
    events.sort((a, b) => a.occurredAt - b.occurredAt || a.eventId.localeCompare(b.eventId));
    const limit = filters.limit == null ? null : Math.max(0, Number(filters.limit));
    return limit == null ? events : events.slice(-limit);
  }

  function rollup(filters = {}, groupBy = []) {
    const keys = Array.isArray(groupBy) ? groupBy : String(groupBy || '').split(',').filter(Boolean);
    const groups = new Map();
    for (const event of query(filters)) {
      const group = Object.fromEntries(keys.map(key => [key, groupValue(event, key)]));
      const id = JSON.stringify(group);
      if (!groups.has(id)) groups.set(id, {
        ...group, events: 0, successfulEvents: 0, failedEvents: 0, observedEvents: 0, unobservableEvents: 0,
        inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        exactEvents: 0, reconciledEvents: 0, totalLatencyMs: 0,
      });
      const row = groups.get(id);
      row.events++;
      if (event.status === 'error') row.failedEvents++;
      else if (event.status === 'success') row.successfulEvents++;
      row[`${event.source}Events`]++;
      row.totalLatencyMs += event.latencyMs || 0;
      if (!event.tokens) { row.unobservableEvents++; continue; }
      row.observedEvents++;
      row.inputTokens += event.tokens.input;
      row.outputTokens += event.tokens.output;
      row.cacheRead += event.tokens.cacheRead;
      row.cacheWrite += event.tokens.cacheWrite;
      row.totalTokens += event.tokens.total;
    }
    return Array.from(groups.values()).map(row => ({
      ...row,
      coverageRatio: row.events ? Number((row.observedEvents / row.events).toFixed(4)) : 0,
      avgLatencyMs: row.events ? Math.round(row.totalLatencyMs / row.events) : 0,
    }));
  }

  function getPolicy() {
    const policy = readJson(policyFile, {}) || {};
    const retentionDays = Number(policy.retentionDays || options.retentionDays || DEFAULT_RETENTION_DAYS);
    return { retentionDays: Number.isFinite(retentionDays) && retentionDays > 0 ? Math.floor(retentionDays) : DEFAULT_RETENTION_DAYS };
  }

  function setRetentionDays(days) {
    const value = Math.floor(Number(days));
    if (!Number.isFinite(value) || value < 1) throw new Error('retention days must be at least 1');
    const policy = { retentionDays: value, updatedAt: Date.now() };
    writeJsonAtomic(policyFile, policy);
    return policy;
  }

  function prune(pruneOptions = {}) {
    const retentionDays = Number(pruneOptions.retentionDays || getPolicy().retentionDays);
    if (!Number.isFinite(retentionDays) || retentionDays < 1) throw new Error('retention days must be at least 1');
    const cutoff = Number(pruneOptions.now || Date.now()) - retentionDays * 86400000;
    if (externalStorage) {
      if (typeof externalStorage.prune !== 'function') {
        return { retentionDays, dryRun: !!pruneOptions.dryRun, removed: [], removedCount: 0, supported: false };
      }
      const result = externalStorage.prune({
        cutoff,
        retentionDays,
        dryRun: !!pruneOptions.dryRun,
        now: Number(pruneOptions.now || Date.now()),
      }) || {};
      return { retentionDays, dryRun: !!pruneOptions.dryRun, ...result };
    }
    const removed = [];
    return withLock(() => {
      for (const file of shardFiles()) {
        const match = /events-(\d{4}-\d{2}-\d{2})\./.exec(path.basename(file));
        const shardEnd = match ? Date.parse(`${match[1]}T23:59:59.999Z`) : Infinity;
        if (shardEnd >= cutoff) continue;
        removed.push(file);
        if (!pruneOptions.dryRun) removeFile(file);
      }
      if (!pruneOptions.dryRun && removed.length) eventIds = null;
      return { retentionDays, dryRun: !!pruneOptions.dryRun, removed, removedCount: removed.length };
    });
  }

  return {
    append, recordProxyUsage, recordUnobservable, query, rollup,
    getPolicy, setRetentionDays, prune,
    storageContractVersion: USAGE_STORAGE_CONTRACT_VERSION,
    _storage: externalStorage,
    _paths: paths,
    _usageDir: usageDir,
  };
}

module.exports = {
  USAGE_SCHEMA_VERSION,
  USAGE_STORAGE_CONTRACT_VERSION,
  DEFAULT_RETENTION_DAYS,
  normalizeUsageEvent,
  createUsageLedger,
};
