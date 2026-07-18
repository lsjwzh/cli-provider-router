'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(__dirname, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
  .map(entry => path.join(__dirname, entry.name))
  .sort();

if (!files.length) {
  console.error('No test files found.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  cwd: root,
  stdio: 'inherit',
});

if (result.error) console.error(result.error.message);
process.exit(result.status == null ? 1 : result.status);
