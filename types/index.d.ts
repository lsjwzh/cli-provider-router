/// <reference types="node" />

import type { IncomingMessage, ServerResponse } from 'node:http';

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
  baseUrl?: string; model?: string; modelOptions?: string[];
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

export const API_VERSION: '1.0.0';
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
export function resolveSpawnEnv(options: { cli: string; providerId?: string; store: ProviderStore; paths?: CprPaths; cprHome?: string }): SpawnResolution;
export function buildChildEnv(base: NodeJS.ProcessEnv, options: { cli: string; providerId?: string; store: ProviderStore; [key: string]: unknown }, extra?: NodeJS.ProcessEnv): SpawnResolution;
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
export function mountClaudeProxy(app: any, options?: Record<string, unknown>): any;
export function mountCodexProxy(app: any, options?: Record<string, unknown>): any;
export function mountCcSwitchGateway(app: any, options?: Record<string, unknown>): any;
export function createClaudeHandler(options?: Record<string, unknown>): (req: IncomingMessage, res: ServerResponse) => void;
export function createCodexHandler(options?: Record<string, unknown>): (req: IncomingMessage, res: ServerResponse) => void;
export function createWebApp(options?: Record<string, unknown>): any;
export function createWebServer(options?: Record<string, unknown>): any;

export const ccSwitchTakeover: Readonly<Record<string, (...args: any[]) => any>>;

// Compatibility surface retained from 0.2.x. Precise domain types will grow
// additively; these declarations intentionally avoid inventing unstable DTOs.
export const ALIAS_TIER_KEYS: any; export const ALIAS_TIER_REGEX: RegExp;
export const ANTHROPIC_ROUTING_KEYS: any; export const CC_DB_DEFAULT: string;
export const CLAUDE_ROUTING_KEYS: any; export const CODEX_HOMES_DIR: string;
export const DOMESTIC_PROXY_MAP: any; export const RESPONSES_COMPAT_PROXY_MAP: any;
export const WIRE_DEFAULT_MODEL: string; export const CLAUDE_MANAGED_ENV_KEYS: any;
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
