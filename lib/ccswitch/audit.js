'use strict';

const fs = require('fs');
const path = require('path');
const { ensurePrivateDir, takeoverRoot } = require('./common');

function auditPath(home) {
  return path.join(takeoverRoot(home), 'audit.jsonl');
}

function appendAudit(home, event, details = {}) {
  const file = auditPath(home);
  ensurePrivateDir(path.dirname(file));
  const record = { at: new Date().toISOString(), event, ...details };
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) {}
  return record;
}

function readAudit(home, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 100, 10000));
  try {
    return fs.readFileSync(auditPath(home), 'utf8').trim().split('\n').filter(Boolean)
      .slice(-limit).map(line => JSON.parse(line));
  } catch (_) { return []; }
}

module.exports = { appendAudit, auditPath, readAudit };
