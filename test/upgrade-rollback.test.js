'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 180000, ...options });
}

function copyReleaseSource(destination) {
  const included = [
    'cli', 'lib', 'schema', 'scripts', 'types', 'web', 'docs',
    'defaults.json', 'package.json', 'package-lock.json', 'README.md',
    'README.zh-CN.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'LICENSE',
  ];
  fs.mkdirSync(destination, { recursive: true });
  for (const item of included) fs.cpSync(path.join(root, item), path.join(destination, item), { recursive: true });
}

test('failed side-by-side upgrade restores artifact pointer, CPR_HOME and stopped service state', { timeout: 180000 }, () => {
  if (process.platform === 'win32') return test.skip('Bash rollback smoke is covered by the Windows CI script contract');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-upgrade-rollback-'));
  try {
    const oldSource = path.join(temp, 'old-source');
    const installRoot = path.join(temp, 'install');
    const binDir = path.join(temp, 'bin');
    const home = path.join(temp, 'home');
    copyReleaseSource(oldSource);
    const oldVersion = '0.2.99';
    for (const file of ['package.json', 'package-lock.json']) {
      const full = path.join(oldSource, file);
      const json = JSON.parse(fs.readFileSync(full, 'utf8'));
      json.version = oldVersion;
      if (json.packages && json.packages['']) json.packages[''].version = oldVersion;
      fs.writeFileSync(full, `${JSON.stringify(json, null, 2)}\n`);
    }

    let result = run('bash', ['scripts/install.sh', '--source', oldSource, '--version', oldVersion,
      '--install-root', installRoot, '--bin-dir', binDir, '--cpr-home', home]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const oldTarget = fs.readlinkSync(path.join(installRoot, 'current'));
    const sentinel = path.join(home, 'data', 'rollback-sentinel.json');
    fs.writeFileSync(sentinel, '{"preserve":true}\n', { mode: 0o600 });

    result = run('bash', ['scripts/upgrade.sh', '--source', root, '--version', pkg.version,
      '--install-root', installRoot, '--bin-dir', binDir, '--cpr-home', home], {
      env: { ...process.env, CPR_UPGRADE_TEST_FAIL_AFTER_HEALTH: '1' },
    });
    assert.notEqual(result.status, 0, 'fault-injected upgrade must fail');
    assert.match(`${result.stdout}\n${result.stderr}`, /Restored previous artifact, data and service state/);
    assert.equal(fs.readlinkSync(path.join(installRoot, 'current')), oldTarget);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), '{"preserve":true}\n');
    const cpr = path.join(binDir, 'cpr');
    assert.equal(run(cpr, ['--version'], { env: { ...process.env, CPR_HOME: home } }).stdout.trim(), oldVersion);
    assert.notEqual(run(cpr, ['status'], { env: { ...process.env, CPR_HOME: home } }).status, 0, 'service must remain stopped');

    const versions = fs.readdirSync(path.join(installRoot, 'versions')).filter(name => !name.startsWith('.'));
    assert.equal(versions.length, 2, 'old and failed candidate artifacts stay side-by-side for diagnosis');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
