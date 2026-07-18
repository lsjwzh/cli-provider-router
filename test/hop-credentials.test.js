'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHopCredentialStore } = require('../lib/proxy/hop-credentials');

function route(overrides = {}) {
  return {
    cli: 'codex', providerId: 'provider-1', sessionId: 'direct-profile-1',
    roleKind: 'sub', agentRole: 'worker', routeName: 'worker',
    ...overrides,
  };
}

test('hop credentials fail closed for missing, wrong, cross-route, expired and revoked tokens', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-hop-credential-'));
  let clock = 1_000_000;
  try {
    const store = createHopCredentialStore({ cprHome: home, now: () => clock, ttlMs: 1_000 });
    const issued = store.issue(route());
    assert.equal(store.verify(route(), '').reason, 'missing');
    assert.equal(store.verify(route(), 'wrong').reason, 'mismatch');
    assert.equal(store.verify(route({ routeName: 'explorer', agentRole: 'explorer' }), issued.token).reason, 'unmanaged-route');
    assert.equal(store.verify(route(), issued.token).ok, true);

    clock += 1_001;
    assert.equal(store.verify(route(), issued.token).reason, 'expired');

    clock += 1;
    const replacement = store.issue(route());
    assert.equal(store.verify(route(), replacement.token).ok, true);
    store.revoke({ id: replacement.id }, 'test');
    assert.equal(store.verify(route(), replacement.token).reason, 'revoked');

    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(home, 'run')).mode & 0o777, 0o700);
      assert.equal(fs.statSync(store.dataFile).mode & 0o777, 0o600);
    }
    assert.doesNotMatch(fs.readFileSync(store.dataFile, 'utf8'), new RegExp(replacement.token));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
