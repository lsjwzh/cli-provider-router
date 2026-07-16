'use strict';

// index.js — aggregation entry point for cli-provider-router.
//
// Re-exports the constants, the createStore() factory, the spawn-env helpers,
// and the two express-mountable proxies (claude / codex) as a single module.
// Importing `require('cli-provider-router')` gives you everything you need to
// build a server that routes any AI CLI to a per-invocation upstream provider.

const constants = require('./constants');
const { createStore } = require('./store');
const spawnEnv = require('./spawn-env');
const claudeProxy = require('./proxy/claude');
const codexProxy = require('./proxy/codex');
const codexTransform = require('./proxy/codex-transform');
const routing = require('./routing');
const paths = require('./paths');
const atomicJson = require('./atomic-json');
const routeProfiles = require('./route-profile-store');
const service = require('./service');
const ccSwitchTakeover = require('./ccswitch');
const webApi = require('./web-api');
const usageLedger = require('./usage-ledger');
const settingsStore = require('./settings-store');
const directCliConfig = require('./direct-cli-config');

module.exports = {
  ...constants,
  ...spawnEnv,
  ...routing,
  ...paths,
  ...atomicJson,
  ...routeProfiles,
  ...service,
  ...usageLedger,
  ...settingsStore,
  ...directCliConfig,
  ...codexTransform,
  createStore,
  createClaudeHandler: claudeProxy.createHandler,
  parseClaudeProxyUrl: claudeProxy.parseProxyUrl,
  decodeClaudeRoutedModel: claudeProxy.decodeCcfwModel,
  CPR_MODEL_PREFIX: claudeProxy.CPR_PREFIX,
  LEGACY_MODEL_PREFIXES: claudeProxy.LEGACY_MODEL_PREFIXES,
  readOfficialOAuthToken: claudeProxy.readOfficialOAuthToken,
  createCodexHandler: codexProxy.createCodexHandler,
  normalizeResponsesUsage: codexProxy.normalizeResponsesUsage,
  resolveCodexProviderTarget: codexProxy.resolveProviderTarget,
  mountClaudeProxy: claudeProxy.mountClaudeProxy,
  mountCodexProxy: codexProxy.mountCodexProxy,
  ccSwitchTakeover,
  createCcSwitchGatewayHandler: ccSwitchTakeover.createCcSwitchGatewayHandler,
  mountCcSwitchGateway: ccSwitchTakeover.mountCcSwitchGateway,
  ...webApi,
};
