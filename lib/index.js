'use strict';

// Stable CommonJS facade. Keep this list explicit: broad object spreads made
// name collisions depend on require order and silently changed the host API.
const metadata = require('./api-metadata');
const constants = require('./constants');
const store = require('./store');
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
const sqliteRuntime = require('./sqlite-runtime');
const hopCredentials = require('./proxy/hop-credentials');
const takeoverState = require('./takeover-state');
const modelPolicy = require('./model-policy');
const httpTarget = require('./http-target');
const hostEmbedding = require('./host-embedding');

module.exports = {
  API_VERSION: metadata.API_VERSION,
  CAPABILITIES: metadata.CAPABILITIES,

  ALIAS_TIER_KEYS: constants.ALIAS_TIER_KEYS,
  ANTHROPIC_ALIAS_MODEL_KEYS: constants.ANTHROPIC_ALIAS_MODEL_KEYS,
  ANTHROPIC_ALIAS_MODEL_PRIORITY: constants.ANTHROPIC_ALIAS_MODEL_PRIORITY,
  ALIAS_TIER_REGEX: constants.ALIAS_TIER_REGEX,
  ANTHROPIC_ROUTING_KEYS: constants.ANTHROPIC_ROUTING_KEYS,
  APP_TYPES: constants.APP_TYPES,
  CC_DB_DEFAULT: constants.CC_DB_DEFAULT,
  CLAUDE_ROUTING_KEYS: constants.CLAUDE_ROUTING_KEYS,
  CODEX_ROUTING_KEYS: constants.CODEX_ROUTING_KEYS,
  CODEX_HOMES_DIR: constants.CODEX_HOMES_DIR,
  DEFAULT_PROXY_PORT: constants.DEFAULT_PROXY_PORT,
  DOMESTIC_PROXY_MAP: constants.DOMESTIC_PROXY_MAP,
  RESPONSES_COMPAT_PROXY_MAP: constants.RESPONSES_COMPAT_PROXY_MAP,
  WIRE_DEFAULT_MODEL: constants.WIRE_DEFAULT_MODEL,
  appTypeForCli: constants.appTypeForCli,
  ccSwitchAvailable: constants.ccSwitchAvailable,
  resolveCcDb: constants.resolveCcDb,

  createStore: store.createStore,
  applyClaudeProxyEnv: routing.applyClaudeProxyEnv,
  buildChildEnv: spawnEnv.buildChildEnv,
  ProviderRoutingError: spawnEnv.ProviderRoutingError,
  probeRelayModels: spawnEnv.probeRelayModels,
  resolveSessionWireModel: spawnEnv.resolveSessionWireModel,
  resolveSpawnEnv: spawnEnv.resolveSpawnEnv,
  stripModelSuffix: modelPolicy.stripModelSuffix,
  modelValidForProvider: modelPolicy.modelValidForProvider,
  validateModel: modelPolicy.validateModel,
  resolveWireModel: modelPolicy.resolveWireModel,
  DEFAULT_LOCAL_PROXY_PATHS: httpTarget.DEFAULT_LOCAL_PROXY_PATHS,
  isLocalProxyUrl: httpTarget.isLocalProxyUrl,
  resolveHttpTarget: httpTarget.resolveHttpTarget,
  prepareSessionRouting: hostEmbedding.prepareSessionRouting,

  DEFAULT_CODEX_AGENT_ROLES: routing.DEFAULT_CODEX_AGENT_ROLES,
  DEFAULT_CODEX_SUBAGENT_PROVIDER: routing.DEFAULT_CODEX_SUBAGENT_PROVIDER,
  LEGACY_CODEX_SUBAGENT_PROVIDER: routing.LEGACY_CODEX_SUBAGENT_PROVIDER,
  applyCodexProxyConfig: routing.applyCodexProxyConfig,
  codexProviderProxyable: routing.codexProviderProxyable,
  materializeCodexAuth: routing.materializeCodexAuth,
  materializeCodexRoutingHome: routing.materializeCodexRoutingHome,

  DIRECTORY_MODE: paths.DIRECTORY_MODE,
  FILE_MODE: paths.FILE_MODE,
  createCprPaths: paths.createCprPaths,
  ensureCprPaths: paths.ensureCprPaths,
  resolveCprHome: paths.resolveCprHome,
  secureDirectory: paths.secureDirectory,
  atomicWriteFile: atomicJson.atomicWriteFile,
  readJson: atomicJson.readJson,
  removeFile: atomicJson.removeFile,
  writeJsonAtomic: atomicJson.writeJsonAtomic,

  ROUTE_PROFILE_SCHEMA_VERSION: routeProfiles.ROUTE_PROFILE_SCHEMA_VERSION,
  createRouteProfileStore: routeProfiles.createRouteProfileStore,
  normalizeRouteProfile: routeProfiles.normalizeRouteProfile,
  createServiceController: service.createServiceController,
  isPidRunning: service.isPidRunning,
  probeHealth: service.probeHealth,
  readPid: service.readPid,

  DEFAULT_RETENTION_DAYS: usageLedger.DEFAULT_RETENTION_DAYS,
  USAGE_SCHEMA_VERSION: usageLedger.USAGE_SCHEMA_VERSION,
  USAGE_STORAGE_CONTRACT_VERSION: usageLedger.USAGE_STORAGE_CONTRACT_VERSION,
  createUsageLedger: usageLedger.createUsageLedger,
  normalizeUsageEvent: usageLedger.normalizeUsageEvent,
  createSettingsStore: settingsStore.createSettingsStore,

  CLAUDE_MANAGED_ENV_KEYS: directCliConfig.CLAUDE_MANAGED_ENV_KEYS,
  DIRECT_PROVIDER_PREFIX: directCliConfig.DIRECT_PROVIDER_PREFIX,
  LOCAL_BEARER_TOKEN: directCliConfig.LOCAL_BEARER_TOKEN,
  SNAPSHOT_VERSION: directCliConfig.SNAPSHOT_VERSION,
  createDirectCliConfigManager: directCliConfig.createDirectCliConfigManager,
  profileHash: directCliConfig.profileHash,

  HOP_CREDENTIAL_SCHEMA_VERSION: hopCredentials.HOP_CREDENTIAL_SCHEMA_VERSION,
  DEFAULT_HOP_TTL_MS: hopCredentials.DEFAULT_HOP_TTL_MS,
  createHopCredentialStore: hopCredentials.createHopCredentialStore,
  authorizeManagedRequest: hopCredentials.authorizeManagedRequest,
  normalizeHopRole: hopCredentials.normalizeRole,
  createTakeoverStateStore: takeoverState.createTakeoverStateStore,
  isActiveTakeoverState: takeoverState.isActiveState,
  takeoverStatePhase: takeoverState.statePhase,

  REPAIR_COMMAND: sqliteRuntime.REPAIR_COMMAND,
  SAFE_MESSAGE: sqliteRuntime.SAFE_MESSAGE,
  createSqliteRuntime: sqliteRuntime.createSqliteRuntime,
  openSqliteDatabase: sqliteRuntime.openSqliteDatabase,
  requireSqliteDatabase: sqliteRuntime.requireSqliteDatabase,
  sqliteRuntimeStatus: sqliteRuntime.sqliteRuntimeStatus,
  sqliteUnavailableError: sqliteRuntime.sqliteUnavailableError,

  chatStreamToResponses: codexTransform.chatStreamToResponses,
  responsesToChat: codexTransform.responsesToChat,
  createClaudeHandler: claudeProxy.createHandler,
  parseClaudeProxyUrl: claudeProxy.parseProxyUrl,
  decodeClaudeRoutedModel: claudeProxy.decodeCcfwModel,
  CPR_MODEL_PREFIX: claudeProxy.CPR_PREFIX,
  LEGACY_MODEL_PREFIXES: claudeProxy.LEGACY_MODEL_PREFIXES,
  readOfficialOAuthToken: claudeProxy.readOfficialOAuthToken,
  mountClaudeProxy: claudeProxy.mountClaudeProxy,
  createCodexHandler: codexProxy.createCodexHandler,
  normalizeResponsesUsage: codexProxy.normalizeResponsesUsage,
  resolveCodexProviderTarget: codexProxy.resolveProviderTarget,
  mountCodexProxy: codexProxy.mountCodexProxy,

  ccSwitchTakeover,
  createCcSwitchGatewayHandler: ccSwitchTakeover.createCcSwitchGatewayHandler,
  mountCcSwitchGateway: ccSwitchTakeover.mountCcSwitchGateway,

  createWebApp: webApi.createWebApp,
  createWebServer: webApi.createWebServer,
  profileToView: webApi.profileToView,
  providerReferences: webApi.providerReferences,
  redact: webApi.redact,
  validateProviderInput: webApi.validateProviderInput,
  validateRouteProfile: webApi.validateRouteProfile,
  viewToProfile: webApi.viewToProfile,
};
