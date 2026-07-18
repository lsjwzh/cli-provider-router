'use strict';

// This version describes the public JavaScript contract, independently from
// the package release version. Hosts can negotiate features without guessing
// from semver or probing private files.
const API_VERSION = '1.1.0';

const CAPABILITIES = Object.freeze({
  providerStore: '1.1',
  durableConfigStore: '1.0',
  spawnEnvironment: '1.0',
  protocolProxy: '1.0',
  agentRouting: '1.0',
  normalizedUsage: '1.0',
  ccSwitchReadOnlyImport: '1.0',
  ccSwitchTakeover: '1.0',
  directCliTakeover: '1.0',
  managedHopCredentials: '1.0',
  takeoverLifecycle: '1.0',
  managedService: '1.0',
  webConsole: '1.0',
  modelPolicy: '1.0',
  httpTarget: '1.0',
  hostEmbedding: '1.0',
  managedRouteCredential: '1.0',
});

module.exports = { API_VERSION, CAPABILITIES };
