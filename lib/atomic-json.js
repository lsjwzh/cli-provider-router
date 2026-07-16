'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DIRECTORY_MODE, FILE_MODE, secureDirectory } = require('./paths');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return typeof fallback === 'function' ? fallback() : fallback; }
}

function atomicWriteFile(file, contents, options = {}) {
  const dir = path.dirname(file);
  secureDirectory(dir);
  const mode = options.mode == null ? FILE_MODE : options.mode;
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, contents, options.encoding || 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, mode); } catch (_) {}
    try {
      const dirFd = fs.openSync(dir, 'r');
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
    } catch (_) {}
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    throw error;
  }
}

function writeJsonAtomic(file, value) {
  atomicWriteFile(file, JSON.stringify(value, null, 2) + '\n');
}

function removeFile(file) {
  try { fs.rmSync(file, { force: true }); } catch (_) {}
}

module.exports = {
  DIRECTORY_MODE,
  FILE_MODE,
  readJson,
  atomicWriteFile,
  writeJsonAtomic,
  removeFile,
};
