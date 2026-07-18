'use strict';

const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { createCprPaths, ensureCprPaths, DEFAULT_PROXY_PORT } = require('./paths');
const { readJson, atomicWriteFile, writeJsonAtomic, removeFile, FILE_MODE } = require('./atomic-json');
const { createTakeoverStateStore } = require('./takeover-state');

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
    const webPort = Number(state.webPort || options.webPort || port + 1);
    const processRunning = isPidRunning(pid);
    const health = processRunning ? await probeHealth(port) : null;
    if (!processRunning) {
      removeFile(paths.servicePidFile);
      removeFile(paths.serviceHealthFile);
    }
    return { running: processRunning && !!health, processRunning, healthy: !!health, pid, port, webPort, health, state };
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
    const webPort = Number(startOptions.webPort || options.webPort || port + 1);
    if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535 || webPort === port) throw new Error('web-port must be valid and different from proxy port');
    const logFd = fs.openSync(paths.serviceLogFile, 'a', FILE_MODE);
    try { fs.chmodSync(paths.serviceLogFile, FILE_MODE); } catch (_) {}
    const child = spawn(process.execPath, [runner, '--port', String(port), '--web-port', String(webPort), '--home', paths.home], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        CPR_HOME: paths.home,
        CPR_PORT: String(port),
        CPR_WEB_PORT: String(webPort),
        ...(startOptions.dataFile ? { CPR_DATA_FILE: startOptions.dataFile } : {}),
        ...(startOptions.ccSwitchDb ? { CPR_CC_SWITCH_DB: startOptions.ccSwitchDb } : {}),
      },
      windowsHide: true,
    });
    fs.closeSync(logFd);
    child.unref();
    atomicWriteFile(paths.servicePidFile, `${child.pid}\n`);
    writeJsonAtomic(paths.serviceStateFile, { status: 'starting', pid: child.pid, port, proxyPort: port, webPort, startedAt: Date.now() });
    const deadline = Date.now() + (startOptions.timeoutMs || 5000);
    while (Date.now() < deadline) {
      const health = await probeHealth(port);
      if (health && Number(health.pid) === child.pid && Number(health.webPort) === webPort) {
        return { running: true, processRunning: true, healthy: true, pid: child.pid, port, webPort, health };
      }
      if (!isPidRunning(child.pid)) break;
      await delay(100);
    }
    try { process.kill(child.pid, 'SIGTERM'); } catch (_) {}
    removeFile(paths.servicePidFile);
    removeFile(paths.serviceHealthFile);
    writeJsonAtomic(paths.serviceStateFile, {
      status: 'failed', pid: null, port, proxyPort: port, webPort,
      failedAt: Date.now(), reason: 'startup-health-check-failed',
    });
    throw new Error(`service failed to become healthy; see ${paths.serviceLogFile}`);
  }

  async function stop(stopOptions = {}) {
    // `force` controls SIGKILL escalation only. It must never bypass takeover
    // protection because that would strand user configuration on localhost.
    createTakeoverStateStore(paths).assertCanStop('stop CPR service');
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
      // The child also checks lifecycle state in its signal handler. Re-check
      // immediately before escalation so an apply racing with stop can never
      // turn a refused SIGTERM into a stranding SIGKILL.
      createTakeoverStateStore(paths).assertCanStop('force-stop CPR service');
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
    const webPort = restartOptions.webPort || current.webPort || options.webPort || Number(port) + 1;
    await stop(restartOptions);
    return start({ ...restartOptions, port, webPort });
  }

  return { paths, status, start, stop, restart };
}

module.exports = { readPid, isPidRunning, probeHealth, createServiceController };
