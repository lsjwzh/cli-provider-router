'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const scriptsDir = path.join(root, 'scripts');
const shellScripts = ['install.sh', 'upgrade.sh', 'uninstall.sh'];
const powerShellScripts = ['install.ps1', 'upgrade.ps1', 'uninstall.ps1'];

test('installer suite has fixed-version, home, health and takeover guards', () => {
  for (const file of [...shellScripts, ...powerShellScripts]) {
    assert.ok(fs.existsSync(path.join(scriptsDir, file)), `${file} should exist`);
  }

  const installSh = fs.readFileSync(path.join(scriptsDir, 'install.sh'), 'utf8');
  assert.match(installSh, /--version is required/);
  assert.match(installSh, /package\.json version/);
  assert.match(installSh, /CPR_HOME_VALUE/);
  assert.match(installSh, /doctor/);
  assert.match(installSh, /SHA-256/);

  const upgradeSh = fs.readFileSync(path.join(scriptsDir, 'upgrade.sh'), 'utf8');
  assert.match(upgradeSh, /cpr-home\.tar\.gz/);
  assert.match(upgradeSh, /rollback/);
  assert.match(upgradeSh, /doctor/);

  const uninstallSh = fs.readFileSync(path.join(scriptsDir, 'uninstall.sh'), 'utf8');
  assert.match(uninstallSh, /integration-state\.json/);
  assert.match(uninstallSh, /takeover is active/);
  assert.match(uninstallSh, /--purge/);
});

test('source installer dry-run validates without writing installation data', () => {
  const version = require('../package.json').version;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-script-dry-'));
  const result = spawnSync('bash', [path.join(scriptsDir, 'install.sh'),
    '--source', root, '--version', version,
    '--install-root', path.join(temp, 'install'),
    '--bin-dir', path.join(temp, 'bin'),
    '--cpr-home', path.join(temp, 'home'), '--dry-run'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry-run ok/);
  assert.equal(fs.existsSync(path.join(temp, 'install')), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test('uninstall refuses active CC-Switch takeover and preserves installation', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-script-active-'));
  const installRoot = path.join(temp, 'install');
  const binDir = path.join(temp, 'bin');
  const cprHome = path.join(temp, 'home');
  fs.mkdirSync(path.join(cprHome, 'data'), { recursive: true });
  fs.mkdirSync(installRoot, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(installRoot, 'sentinel'), 'keep');
  fs.writeFileSync(path.join(cprHome, 'data', 'integration-state.json'), JSON.stringify({ ccSwitch: { status: 'active' } }));

  const result = spawnSync('bash', [path.join(scriptsDir, 'uninstall.sh'),
    '--install-root', installRoot, '--bin-dir', binDir, '--cpr-home', cprHome], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /takeover is active/);
  assert.ok(fs.existsSync(path.join(installRoot, 'sentinel')));
  fs.rmSync(temp, { recursive: true, force: true });
});

test('PowerShell scripts parse when pwsh is available', (t) => {
  const probe = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
  if (probe.error && probe.error.code === 'ENOENT') {
    t.skip('pwsh is not installed on this platform');
    return;
  }
  assert.equal(probe.status, 0, probe.stderr);
  for (const file of powerShellScripts) {
    const full = path.join(scriptsDir, file).replace(/'/g, "''");
    const command = `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${full}',[ref]$null,[ref]$e); if($e.Count){$e | Out-String | Write-Error; exit 1}`;
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', command], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

test('documentation distinguishes MultiCC sync from CPR takeover', () => {
  for (const file of ['README.md', 'README.zh-CN.md', 'docs/ccswitch-safety.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(text, /MultiCC/);
    assert.match(text, /takeover|接管/i);
    assert.match(text, /read-only|只读/i);
  }
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /npm package has \*\*not been published yet\*\*/);
  assert.match(readme, /In development/);
});
