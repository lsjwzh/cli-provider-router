'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createCprPaths, ensureCprPaths, FILE_MODE } = require('./paths');
const { readJson, writeJsonAtomic, removeFile } = require('./atomic-json');

const USAGE_SCHEMA_VERSION = 1;
const DEFAULT_RETENTION_DAYS = 90;
const ROLES = new Set(['main', 'sub', 'aux']);
const SOURCES = new Set(['exact', 'reconciled']);
const STATUSES = new Set(['success', 'error', 'unobservable']);

function number(value, label) {
  const n = Number(value == null ? 0 : value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative number`);
  return n;
}

function normalizeTokens(tokens, status) {
  if (status === 'unobservable') {
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
  const role = String(input.role || '').trim();
  const source = String(input.source || 'exact').trim();
  const status = String(input.status || 'success').trim();
  if (!ROLES.has(role)) throw new Error('role must be main, sub, or aux');
  if (!SOURCES.has(source)) throw new Error('source must be exact or reconciled');
  if (!STATUSES.has(status)) throw new Error('status must be success, error, or unobservable');
  const providerId = String(input.providerId || '').trim();
  if (!providerId) throw new Error('providerId is required');
  const externalSessionId = String(input.externalSessionId || input.sessionId || '').trim();
  if (!externalSessionId) throw new Error('externalSessionId is required');
  const protocol = String(input.protocol || '').trim();
  if (!protocol) throw new Error('protocol is required');
  return {
    version: USAGE_SCHEMA_VERSION,
    eventId,
    occurredAt,
    externalSessionId,
    role,
    providerId,
    providerName: String(input.providerName || '').trim(),
    model: String(input.model || '').trim(),
    protocol,
    tokens: normalizeTokens(input.tokens || input.usage, status),
    latencyMs: number(input.latencyMs, 'latencyMs'),
    status,
    ...(input.statusCode == null ? {} : { statusCode: number(input.statusCode, 'statusCode') }),
    source,
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
    ['role', 'role'], ['providerId', 'providerId'], ['provider', 'providerId'],
    ['model', 'model'], ['externalSessionId', 'externalSessionId'], ['session', 'externalSessionId'],
    ['protocol', 'protocol'], ['source', 'source'], ['status', 'status'],
  ];
  for (const [filterKey, eventKey] of mappings) {
    if (filters[filterKey] != null && String(filters[filterKey]) !== String(event[eventKey])) return false;
  }
  return true;
}

function groupValue(event, key) {
  if (key === 'date') return dateKey(event.occurredAt);
  if (key === 'provider') return event.providerId || '';
  if (key === 'session') return event.externalSessionId || '';
  return event[key] || '';
}

function createUsageLedger(options = {}) {
  const paths = ensureCprPaths(options.paths || createCprPaths({ home: options.cprHome }));
  const usageDir = options.usageDir || paths.usageDir;
  const policyFile = options.policyFile || paths.usagePolicyFile;
  fs.mkdirSync(usageDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(usageDir, 0o700); } catch (_) {}
  const lockFile = path.join(usageDir, '.ledger.lock');

  function shardFiles() {
    return fs.readdirSync(usageDir)
      .filter(name => /^events-\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .sort()
      .map(name => path.join(usageDir, name));
  }
  function shardFile(timestamp) { return path.join(usageDir, `events-${dateKey(timestamp)}.json`); }
  function readShard(file) {
    const value = readJson(file, null);
    if (value === null && fs.existsSync(file)) throw new Error(`usage shard is unreadable: ${file}`);
    if (value === null) return [];
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.events)) return value.events;
    throw new Error(`usage shard has an invalid schema: ${file}`);
  }
  function acquireLock() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { return fs.openSync(lockFile, 'wx', FILE_MODE); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          if (Date.now() - fs.statSync(lockFile).mtimeMs > 30000) removeFile(lockFile);
        } catch (_) {}
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
  function hasEventId(eventId) {
    return shardFiles().some(file => readShard(file).some(event => event.eventId === eventId));
  }
  function append(input) {
    const event = normalizeUsageEvent(input);
    return withLock(() => {
      if (hasEventId(event.eventId)) return { inserted: false, event };
      const file = shardFile(event.occurredAt);
      const events = readShard(file);
      events.push(event);
      writeJsonAtomic(file, { version: USAGE_SCHEMA_VERSION, events });
      return { inserted: true, event };
    });
  }
  function recordProxyUsage(info = {}) {
    return append({
      eventId: info.eventId,
      occurredAt: info.occurredAt || Date.now(),
      externalSessionId: info.externalSessionId || info.sessionId,
      role: info.role,
      providerId: info.providerId,
      providerName: info.providerName,
      model: info.model,
      protocol: info.protocol,
      tokens: info.usage || info.tokens,
      latencyMs: info.latencyMs,
      status: info.status || 'success',
      statusCode: info.statusCode,
      source: info.source || 'exact',
    });
  }
  function recordUnobservable(input = {}) {
    return append({ ...input, status: 'unobservable', tokens: null, source: 'exact' });
  }
  function query(filters = {}) {
    const events = shardFiles().flatMap(readShard).filter(event => eventMatches(event, filters));
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
        ...group, events: 0, observedEvents: 0, unobservableEvents: 0,
        inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        exactEvents: 0, reconciledEvents: 0, totalLatencyMs: 0,
      });
      const row = groups.get(id);
      row.events++;
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
    const removed = [];
    return withLock(() => {
      for (const file of shardFiles()) {
        const key = path.basename(file).slice(7, 17);
        const shardEnd = Date.parse(`${key}T23:59:59.999Z`);
        if (shardEnd >= cutoff) continue;
        removed.push(file);
        if (!pruneOptions.dryRun) removeFile(file);
      }
      return { retentionDays, dryRun: !!pruneOptions.dryRun, removed, removedCount: removed.length };
    });
  }

  return { append, recordProxyUsage, recordUnobservable, query, rollup, getPolicy, setRetentionDays, prune, _paths: paths, _usageDir: usageDir };
}

module.exports = {
  USAGE_SCHEMA_VERSION,
  DEFAULT_RETENTION_DAYS,
  normalizeUsageEvent,
  createUsageLedger,
};
