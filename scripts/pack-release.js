#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed\n${result.stderr || result.stdout}`.trim());
  return String(result.stdout || '').trim();
}

function gitValue(args, fallback = 'unknown') {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return result.status === 0 && String(result.stdout || '').trim()
    ? String(result.stdout).trim()
    : fallback;
}

function parseArgs(argv) {
  const result = { output: path.join(root, 'dist'), requireClean: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--output') result.output = path.resolve(argv[++i] || fail('--output requires a directory'));
    else if (argv[i] === '--require-clean') result.requireClean = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/pack-release.js [--output DIR] [--require-clean]');
      process.exit(0);
    } else fail(`unknown argument: ${argv[i]}`);
  }
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = require(path.join(root, 'package.json'));
  const lock = require(path.join(root, 'package-lock.json'));
  const api = require(path.join(root, 'lib', 'api-metadata.js'));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version)) fail(`package version is not semver: ${pkg.version}`);
  if (lock.version !== pkg.version || !lock.packages || lock.packages[''].version !== pkg.version) {
    fail('package-lock.json version does not match package.json');
  }

  const commit = gitValue(['rev-parse', 'HEAD']);
  const dirty = gitValue(['status', '--porcelain'], '') !== '';
  if (args.requireClean && dirty) fail('working tree is dirty; commit before producing a release artifact');

  fs.mkdirSync(args.output, { recursive: true, mode: 0o700 });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-pack-'));
  try {
    const output = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch]);
    let packed;
    try { packed = JSON.parse(output); } catch (error) { fail(`npm pack returned invalid JSON: ${error.message}`); }
    if (!Array.isArray(packed) || packed.length !== 1 || !packed[0].filename) fail('npm pack did not produce exactly one package');
    const sourceArchive = path.join(scratch, packed[0].filename);
    const archive = path.join(args.output, packed[0].filename);
    fs.copyFileSync(sourceArchive, archive);
    const tarSha256 = sha256(archive);
    const checksumFile = `${archive}.sha256`;
    fs.writeFileSync(checksumFile, `${tarSha256}  ${path.basename(archive)}\n`, { mode: 0o600 });

    const provenance = {
      schemaVersion: 1,
      package: pkg.name,
      version: pkg.version,
      apiVersion: api.API_VERSION,
      capabilities: api.CAPABILITIES,
      commit,
      sourceDirty: dirty,
      tarball: path.basename(archive),
      tarSha256,
      tarSize: fs.statSync(archive).size,
      lockSha256: sha256(path.join(root, 'package-lock.json')),
      node: process.version,
      nodeAbi: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
      createdAt: new Date().toISOString(),
    };
    const provenanceFile = path.join(args.output, `${pkg.name}-${pkg.version}.provenance.json`);
    fs.writeFileSync(provenanceFile, `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ archive, checksumFile, provenanceFile, ...provenance }, null, 2));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main();
