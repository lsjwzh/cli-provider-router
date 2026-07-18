'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 120000, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('release pack contains public runtime, types, schema and scripts only', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-release-pack-'));
  try {
    const output = run(process.execPath, ['scripts/pack-release.js', '--output', temp]);
    const result = JSON.parse(output.stdout);
    assert.equal(result.version, pkg.version);
    assert.equal(result.tarSha256, sha256(result.archive));
    const provenance = JSON.parse(fs.readFileSync(result.provenanceFile, 'utf8'));
    assert.equal(provenance.tarSha256, result.tarSha256);
    assert.equal(provenance.lockSha256, sha256(path.join(root, 'package-lock.json')));
    assert.equal(provenance.apiVersion, require('../lib').API_VERSION);

    const listing = run('tar', ['-tzf', result.archive]).stdout.split(/\r?\n/).filter(Boolean);
    for (const required of [
      'package/lib/index.js', 'package/lib/api-metadata.js',
      'package/types/index.d.ts', 'package/schema/capabilities.schema.json',
      'package/scripts/install.sh', 'package/scripts/upgrade.sh',
      'package/README.md', 'package/README.zh-CN.md',
    ]) assert.ok(listing.includes(required), `tarball missing ${required}`);
    assert.equal(listing.some(file => /(?:^|\/)test\//.test(file)), false);
    assert.equal(listing.some(file => file.includes('node_modules')), false);
    assert.equal(listing.some(file => file.includes('/.git')), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('packed artifact clean-installs and resolves root and documented subpaths', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-clean-install-'));
  try {
    const out = path.join(temp, 'out');
    const prefix = path.join(temp, 'prefix');
    fs.mkdirSync(out);
    const packed = JSON.parse(run(process.execPath, ['scripts/pack-release.js', '--output', out]).stdout);
    run('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', packed.archive]);

    const requireFromInstall = createRequire(path.join(prefix, 'probe.js'));
    const installed = requireFromInstall('cli-provider-router');
    assert.equal(requireFromInstall('cli-provider-router/package.json').version, pkg.version);
    assert.equal(installed.API_VERSION, require('../lib').API_VERSION);
    assert.deepEqual(installed.CAPABILITIES, require('../lib').CAPABILITIES);
    for (const subpath of [
      'store', 'spawn-env', 'routing', 'paths', 'service', 'usage-ledger',
      'direct-cli-config', 'sqlite-runtime', 'ccswitch', 'proxy/claude',
      'proxy/codex', 'proxy/codex-transform', 'web-api', 'api-metadata',
    ]) assert.doesNotThrow(() => requireFromInstall(`cli-provider-router/${subpath}`), subpath);

    const cpr = path.join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'cpr.cmd' : 'cpr');
    const home = path.join(temp, 'home');
    const version = run(cpr, ['--version'], { env: { ...process.env, CPR_HOME: home } });
    assert.equal(version.stdout.trim(), pkg.version);
    run(cpr, ['doctor'], { env: { ...process.env, CPR_HOME: home } });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
