/// <reference types="node" />

import type { IncomingMessage, ServerResponse } from 'node:http';

export type { ModelPolicyProvider, ResolveWireModelOptions } from './model-policy';
export { stripModelSuffix, modelValidForProvider, validateModel, resolveWireModel } from './model-policy';
export type { HttpProtocol, HttpWireApi, HttpTargetOptions, HttpTargetResolution } from './http-target';
export { DEFAULT_LOCAL_PROXY_PATHS, isLocalProxyUrl, resolveHttpTarget } from './http-target';
export type {
  HostProviderStore, SessionRouteInput, PreparedSessionRoute, ManagedRouteCredential,
  ManagedCredentialStore, HostUsageTarget, PrepareSessionRoutingOptions,
  PreparedSessionRouting,
} from './host-embedding';
export { prepareSessionRouting } from './host-embedding';
export type {
  FileLockOptions, FileLockHandle, DurableStoreOptions, DurableLoadResult, DurableStore,
} from './durable-store';
export {
  DEFAULT_LOCK_TIMEOUT_MS, DEFAULT_LOCK_STALE_MS, DEFAULT_DURABLE_BACKUPS,
  CorruptedStateError, RevisionConflictError, LockTimeoutError,
  acquireFileLock, withFileLock, createDurableStore,
} from './durable-store';

export type AppType = 'claude' | 'codex';
export type AgentRole = 'main' | 'sub' | 'aux' | string;

export interface ProviderInput {
  appType: AppType;
  name: string;
  baseUrl?: string;
  authToken?: string;
  model?: string;
  models?: string | string[];
  settingsConfig?: string | Record<string, unknown>;
  [key: string]: unknown;
}

export interface Provider extends ProviderInput { id: string; }
export interface ProviderSummary {
  id: string; appType: AppType; name: string; source?: string;
  baseUrl?: string; protocol: 'anthropic' | 'openai';
  wireApi: 'messages' | 'responses' | 'chat' | 'chat_completions';
  model?: string; modelOptions?: string[];
  aliasOnly?: boolean; tokenMask?: string; hasToken?: boolean;
  useChatResponsesProxy?: boolean; isOfficial?: boolean;
  [key: string]: unknown;
}

export interface ProviderStore {
  listProviders(appType: AppType): ProviderSummary[];
  getProvider(appType: AppType, id: string): Provider | null;
  getProviderSummary(appType: AppType, id: string): ProviderSummary | null;
  createProvider(input: ProviderInput): Provider;
  updateProvider(appType: AppType, id: string, patch: Partial<ProviderInput>): Provider;
  deleteProvider(appType: AppType, id: string): boolean;
  importFromCcSwitch(): { imported: number; updated: number; total: number };
  resolveCodexDirectHttp(id: string): Record<string, unknown>;
}

export interface CprPaths {
  home: string; configDir: string; dataDir: string; runDir: string;
  logsDir: string; backupsDir: string; capturesDir: string;
  codexHomesDir: string; providersFile: string; routeProfilesFile: string;
  usageDir: string; servicePidFile: string; serviceStateFile: string;
  serviceHealthFile: string; serviceLogFile: string; adminTokenFile: string;
  [key: string]: string;
}

export interface SpawnResolution {
  env: Record<string, string>;
  skipDefaultModel: boolean;
  aliasOnly: boolean;
  providerModel: string | null;
  providerModels: string[];
  providerName?: string | null;
  codexHome?: string;
  tools?: unknown;
  routingStatus: 'default' | 'routed' | 'default-fallback';
  fallback: RoutingFallbackState | null;
}

export interface RoutingFailureDetails {
  cli: string;
  providerId: string;
  stage: string;
}

export interface RoutingFallbackState {
  readonly type: 'provider-routing-fallback';
  readonly status: 'default-fallback';
  readonly reason: 'provider-not-found' | 'materialization-failed' | string;
  readonly credentialFree: true;
  readonly cli: string;
  readonly providerId: string;
  readonly error: Readonly<{ name: string; code: string; message: string; stage: string }>;
}

export class ProviderRoutingError extends Error {
  constructor(options: {
    code: string; message: string; cli: string; providerId: string;
    stage: string; cause?: unknown;
  });
  readonly code: string;
  readonly cli: string;
  readonly providerId: string;
  readonly stage: string;
  readonly details: Readonly<RoutingFailureDetails>;
  readonly cause?: unknown;
}

export interface SpawnEnvironmentOptions {
  cli: string;
  providerId?: string;
  store: ProviderStore;
  paths?: CprPaths;
  cprHome?: string;
  codexHomesDir?: string;
  allowDefaultFallback?: boolean;
  onRoutingEvent?: (event: RoutingFallbackState) => void;
}

export interface UsageEvent {
  eventId?: string; timestamp?: string | number; role?: AgentRole;
  roleKind?: 'main' | 'sub' | 'aux'; agentRole?: string | null;
  routeName?: string; coverage?: 'observed' | 'unobservable';
  providerId?: string; model?: string; protocol?: string; source?: string;
  inputTokens?: number; outputTokens?: number; cacheRead?: number;
  cacheWrite?: number; status?: string; latencyMs?: number;
  [key: string]: unknown;
}

export const API_VERSION: '1.2.0';
export const CAPABILITIES: Readonly<Record<string, string>>;
export const APP_TYPES: readonly AppType[];
export const DEFAULT_PROXY_PORT: number;
export const DIRECTORY_MODE: number;
export const FILE_MODE: number;
export const ROUTE_PROFILE_SCHEMA_VERSION: number;
export const USAGE_SCHEMA_VERSION: number;
export const USAGE_STORAGE_CONTRACT_VERSION: number;
export const SNAPSHOT_VERSION: number;
export const DEFAULT_RETENTION_DAYS: number;
export const REPAIR_COMMAND: string;
export const SAFE_MESSAGE: string;
export const CPR_MODEL_PREFIX: string;
export const LEGACY_MODEL_PREFIXES: readonly string[];

export function createStore(options?: { dataFile?: string; ccSwitchDb?: string; paths?: CprPaths }): ProviderStore;
export function resolveSpawnEnv(options: SpawnEnvironmentOptions): SpawnResolution;
export function buildChildEnv(base: NodeJS.ProcessEnv, options: SpawnEnvironmentOptions & { [key: string]: unknown }, extra?: NodeJS.ProcessEnv): SpawnResolution;
export function resolveSessionWireModel(sessionModel: string | null, options?: Record<string, unknown>): string | null;
export function createCprPaths(options?: { home?: string; env?: NodeJS.ProcessEnv }): CprPaths;
export function ensureCprPaths(options?: CprPaths | { home?: string }): CprPaths;
export function resolveCprHome(options?: { home?: string; env?: NodeJS.ProcessEnv }): string;
export function createUsageLedger(options?: Record<string, unknown>): Record<string, (...args: any[]) => any>;
export function normalizeUsageEvent(event: UsageEvent): UsageEvent;
export function createRouteProfileStore(options?: Record<string, unknown>): Record<string, (...args: any[]) => any>;
export function createServiceController(options?: Record<string, unknown>): Record<string, (...args: any[]) => Promise<any>>;
export function createDirectCliConfigManager(options?: Record<string, unknown>): Record<string, (...args: any[]) => any>;
export function createHopCredentialStore(options?: Record<string, unknown>): Record<string, (...args: any[]) => any>;
export function createTakeoverStateStore(options?: CprPaths | { home?: string } | string): Record<string, (...args: any[]) => any>;
export const HOP_CREDENTIAL_SCHEMA_VERSION: number;
export const DEFAULT_HOP_TTL_MS: number;
export const authorizeManagedRequest: (...args: any[]) => any;
export const normalizeHopRole: (...args: any[]) => any;
export const isActiveTakeoverState: (...args: any[]) => boolean;
export const takeoverStatePhase: (...args: any[]) => string;
export function sqliteRuntimeStatus(): { available: boolean; code: string | null; reason: string | null; message: string | null; repair: string | null };
// Metadata-only proxy liveness events (capability `activityEvents`): fired at
// request-forward start, first upstream response byte, and turn end. Never
// carries request/response bodies, headers, tokens, or model output.
export interface ProxyActivityEvent {
  sessionId: string;
  role: AgentRole;
  providerId: string;
  providerName?: string;
  phase: 'request' | 'first_byte' | 'end';
  at: number;
  latencyMs?: number;
  status?: 'success' | 'error';
}
export interface ProxyMountOptions extends Record<string, unknown> {
  onActivity?: (event: ProxyActivityEvent) => void;
}
export function mountClaudeProxy(app: any, options?: ProxyMountOptions): any;
export function mountCodexProxy(app: any, options?: ProxyMountOptions): any;
export function mountCcSwitchGateway(app: any, options?: Record<string, unknown>): any;
export function createClaudeHandler(options?: ProxyMountOptions): (req: IncomingMessage, res: ServerResponse) => void;
export function createCodexHandler(options?: ProxyMountOptions): (req: IncomingMessage, res: ServerResponse) => void;
export function createWebApp(options?: Record<string, unknown>): any;
export function createWebServer(options?: Record<string, unknown>): any;

export const ccSwitchTakeover: Readonly<Record<string, (...args: any[]) => any>>;

// Compatibility surface retained from 0.2.x. Precise domain types will grow
// additively; these declarations intentionally avoid inventing unstable DTOs.
export const ALIAS_TIER_KEYS: any; export const ALIAS_TIER_REGEX: RegExp;
export const ANTHROPIC_ALIAS_MODEL_KEYS: readonly string[];
export const ANTHROPIC_ALIAS_MODEL_PRIORITY: readonly string[];
export const ANTHROPIC_ROUTING_KEYS: readonly string[]; export const CC_DB_DEFAULT: string;
export const CLAUDE_ROUTING_KEYS: readonly string[]; export const CODEX_HOMES_DIR: string;
export const CODEX_ROUTING_KEYS: readonly string[];
export const DOMESTIC_PROXY_MAP: any; export const RESPONSES_COMPAT_PROXY_MAP: any;
export const WIRE_DEFAULT_MODEL: string; export const CLAUDE_MANAGED_ENV_KEYS: readonly string[];
export const DIRECT_PROVIDER_PREFIX: string; export const LOCAL_BEARER_TOKEN: string;
export const DEFAULT_CODEX_AGENT_ROLES: any; export const DEFAULT_CODEX_SUBAGENT_PROVIDER: string;
export const LEGACY_CODEX_SUBAGENT_PROVIDER: string;
export const appTypeForCli: (...args: any[]) => any; export const ccSwitchAvailable: (...args: any[]) => any;
export const resolveCcDb: (...args: any[]) => any; export const applyClaudeProxyEnv: (...args: any[]) => any;
export const probeRelayModels: (...args: any[]) => any; export const applyCodexProxyConfig: (...args: any[]) => any;
export const codexProviderProxyable: (...args: any[]) => any; export const materializeCodexAuth: (...args: any[]) => any;
export const materializeCodexRoutingHome: (...args: any[]) => any; export const secureDirectory: (...args: any[]) => any;
export const atomicWriteFile: (...args: any[]) => any; export const readJson: (...args: any[]) => any;
export const removeFile: (...args: any[]) => any; export const writeJsonAtomic: (...args: any[]) => any;
export const readJsonStrict: (...args: any[]) => any; export const loadOrRecover: (...args: any[]) => any;
export const backupFilePath: (file: string, index: number) => string;
export const rotateJsonBackups: (file: string, keep: number) => void;
export const normalizeRouteProfile: (...args: any[]) => any; export const isPidRunning: (...args: any[]) => any;
export const probeHealth: (...args: any[]) => any; export const readPid: (...args: any[]) => any;
export const createSettingsStore: (...args: any[]) => any; export const createSqliteRuntime: (...args: any[]) => any;
export const openSqliteDatabase: (...args: any[]) => any; export const requireSqliteDatabase: (...args: any[]) => any;
export const sqliteUnavailableError: (...args: any[]) => any; export const chatStreamToResponses: (...args: any[]) => any;
export const responsesToChat: (...args: any[]) => any; export const parseClaudeProxyUrl: (...args: any[]) => any;
export const decodeClaudeRoutedModel: (...args: any[]) => any; export const readOfficialOAuthToken: (...args: any[]) => any;
export const normalizeResponsesUsage: (...args: any[]) => any; export const resolveCodexProviderTarget: (...args: any[]) => any;
export const createCcSwitchGatewayHandler: (...args: any[]) => any; export const profileToView: (...args: any[]) => any;
export const profileHash: (...args: any[]) => string; export const providerReferences: (...args: any[]) => any;
export const redact: (...args: any[]) => any; export const validateProviderInput: (...args: any[]) => any;
export const validateRouteProfile: (...args: any[]) => any; export const viewToProfile: (...args: any[]) => any;
