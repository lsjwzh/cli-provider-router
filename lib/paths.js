'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_PROXY_PORT = 4567;

function resolveCprHome(options = {}) {
  const env = options.env || process.env;
  return path.resolve(options.home || env.CPR_HOME || path.join(os.homedir(), '.cli-provider-router'));
}

function createCprPaths(options = {}) {
  const home = resolveCprHome(options);
  const configDir = path.join(home, 'config');
  const dataDir = path.join(home, 'data');
  const runDir = path.join(home, 'run');
  const logsDir = path.join(home, 'logs');
  const directCliConfigDir = path.join(home, 'direct-cli-config');
  return {
    home,
    configDir,
    dataDir,
    runDir,
    logsDir,
    directCliConfigDir,
    directCliConfigSnapshotsDir: path.join(directCliConfigDir, 'snapshots'),
    directCliConfigStateDir: path.join(directCliConfigDir, 'state'),
    backupsDir: path.join(home, 'backups'),
    capturesDir: path.join(home, 'captures'),
    codexHomesDir: path.join(home, 'codex-homes'),
    settingsFile: path.join(configDir, 'settings.json'),
    providersFile: path.join(dataDir, 'providers.json'),
    routeProfilesFile: path.join(dataDir, 'route-profiles.json'),
    usageDir: path.join(dataDir, 'usage'),
    usagePolicyFile: path.join(configDir, 'usage-policy.json'),
    servicePidFile: path.join(runDir, 'cpr.pid'),
    serviceStateFile: path.join(runDir, 'service.json'),
    serviceHealthFile: path.join(runDir, 'health.json'),
    serviceLogFile: path.join(logsDir, 'service.log'),
    adminTokenFile: path.join(runDir, 'admin-token'),
    legacyProvidersFile: path.join(home, 'providers.json'),
  };
}

function secureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIRECTORY_MODE });
  try { fs.chmodSync(dir, DIRECTORY_MODE); } catch (_) {}
}

function ensureCprPaths(pathsOrOptions = {}) {
  const paths = pathsOrOptions.home && pathsOrOptions.dataDir
    ? pathsOrOptions
    : createCprPaths(pathsOrOptions);
  for (const dir of [
    paths.home,
    paths.configDir,
    paths.dataDir,
    paths.runDir,
    paths.logsDir,
    paths.backupsDir,
    paths.capturesDir,
    paths.codexHomesDir,
    paths.usageDir,
    paths.directCliConfigDir,
    paths.directCliConfigSnapshotsDir,
    paths.directCliConfigStateDir,
  ]) secureDirectory(dir);
  return paths;
}

module.exports = {
  DIRECTORY_MODE,
  FILE_MODE,
  DEFAULT_PROXY_PORT,
  resolveCprHome,
  createCprPaths,
  ensureCprPaths,
  secureDirectory,
};
