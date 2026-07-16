'use strict';

const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { createCprPaths, ensureCprPaths, DEFAULT_PROXY_PORT } = require('./paths');
const { readJson, atomicWriteFile, writeJsonAtomic, removeFile, FILE_MODE } = require('./atomic-json');

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function readPid(file) {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (_) { return null; }
}

function isPidRunning(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === 'EPERM'; }
}

function probeHealth(port, host = '127.0.0.1', timeoutMs = 750) {
  return new Promise(resolve => {
    const request = http.get({ host, port, path: '/health', timeout: timeoutMs }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { if (body.length < 16384) body += chunk; });
      response.on('end', () => {
        try { resolve(response.statusCode === 200 ? JSON.parse(body) : null); }
        catch (_) { resolve(null); }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

function createServiceController(options = {}) {
  const paths = ensureCprPaths(options.paths || createCprPaths({ home: options.cprHome }));
  const runner = options.runner;

  async function status() {
    const state = readJson(paths.serviceStateFile, {}) || {};
    const pid = readPid(paths.servicePidFile) || state.pid || null;
    const port = Number(state.port || options.port || DEFAULT_PROXY_PORT);
    const processRunning = isPidRunning(pid);
    const health = processRunning ? await probeHealth(port) : null;
    if (!processRunning) {
      removeFile(paths.servicePidFile);
      removeFile(paths.serviceHealthFile);
    }
    return { running: processRunning && !!health, processRunning, healthy: !!health, pid, port, health, state };
  }

  async function start(startOptions = {}) {
    const current = await status();
    if (current.processRunning) {
      if (!current.healthy) throw new Error(`service process ${current.pid} exists but health check failed`);
      return { ...current, alreadyRunning: true };
    }
    if (!runner) throw new Error('service runner path is required');
    const port = Number(startOptions.port || options.port || DEFAULT_PROXY_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be between 1 and 65535');
    const logFd = fs.openSync(paths.serviceLogFile, 'a', FILE_MODE);
    try { fs.chmodSync(paths.serviceLogFile, FILE_MODE); } catch (_) {}
    const child = spawn(process.execPath, [runner, '--port', String(port), '--home', paths.home], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        CPR_HOME: paths.home,
        CPR_PORT: String(port),
        ...(startOptions.dataFile ? { CPR_DATA_FILE: startOptions.dataFile } : {}),
      },
      windowsHide: true,
    });
    fs.closeSync(logFd);
    child.unref();
    atomicWriteFile(paths.servicePidFile, `${child.pid}\n`);
    writeJsonAtomic(paths.serviceStateFile, { status: 'starting', pid: child.pid, port, startedAt: Date.now() });
    const deadline = Date.now() + (startOptions.timeoutMs || 5000);
    while (Date.now() < deadline) {
      const health = await probeHealth(port);
      if (health && Number(health.pid) === child.pid) return { running: true, processRunning: true, healthy: true, pid: child.pid, port, health };
      if (!isPidRunning(child.pid)) break;
      await delay(100);
    }
    try { process.kill(child.pid, 'SIGTERM'); } catch (_) {}
    removeFile(paths.servicePidFile);
    removeFile(paths.serviceHealthFile);
    throw new Error(`service failed to become healthy; see ${paths.serviceLogFile}`);
  }

  async function stop(stopOptions = {}) {
    const state = readJson(paths.serviceStateFile, {}) || {};
    const pid = readPid(paths.servicePidFile) || state.pid || null;
    if (!isPidRunning(pid)) {
      removeFile(paths.servicePidFile);
      removeFile(paths.serviceHealthFile);
      return { stopped: false, alreadyStopped: true, pid };
    }
    try { process.kill(pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    const deadline = Date.now() + (stopOptions.timeoutMs || 5000);
    while (Date.now() < deadline && isPidRunning(pid)) await delay(100);
    if (isPidRunning(pid) && stopOptions.force !== false) {
      try { process.kill(pid, 'SIGKILL'); } catch (_) {}
      await delay(50);
    }
    removeFile(paths.servicePidFile);
    removeFile(paths.serviceHealthFile);
    writeJsonAtomic(paths.serviceStateFile, { ...state, status: 'stopped', pid: null, stoppedAt: Date.now() });
    return { stopped: true, pid };
  }

  async function restart(restartOptions = {}) {
    const current = await status();
    const port = restartOptions.port || current.port || options.port || DEFAULT_PROXY_PORT;
    await stop(restartOptions);
    return start({ ...restartOptions, port });
  }

  return { paths, status, start, stop, restart };
}

module.exports = { readPid, isPidRunning, probeHealth, createServiceController };
