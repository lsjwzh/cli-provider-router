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

module.exports = {
  ...constants,
  ...spawnEnv,
  createStore,
  mountClaudeProxy: claudeProxy.mountClaudeProxy,
  mountCodexProxy: codexProxy.mountCodexProxy,
};
