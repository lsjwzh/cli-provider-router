import type { CprPaths, Provider, UsageEvent } from './index';

export interface HostProviderStore {
  getProvider(appType: 'claude' | 'codex', providerId: string): Provider | null;
}

export interface SessionRouteInput {
  providerId: string;
  model?: string;
}

export interface PreparedSessionRoute extends SessionRouteInput {
  role: string;
  roleKind: 'main' | 'sub';
  model: string;
}

export interface ManagedRouteCredential {
  token: string;
  issuedAt: number;
  expiresAt: number;
  bundleId: string;
}

export interface ManagedCredentialStore {
  issueBundle(routes: ReadonlyArray<Record<string, string>>, options?: { expiresAt?: number }): {
    token: string; issuedAt: number; expiresAt: number; bundleId: string;
    credentials: Array<{ id: string }>;
  };
  revoke(selector: { ids: string[] }, reason?: string): { revoked: number; revokedAt?: number };
  verify?(route: Record<string, string>, token: string): Record<string, unknown>;
}

export type HostUsageTarget =
  | ((event: UsageEvent) => unknown)
  | { recordProxyUsage(event: UsageEvent): unknown }
  | { append(event: UsageEvent): unknown };

export interface PrepareSessionRoutingOptions {
  cli: 'claude' | 'codex';
  externalSessionId?: string;
  /** Compatibility alias for externalSessionId. */
  sessionId?: string;
  main?: SessionRouteInput;
  providerId?: string;
  model?: string;
  subagent?: SessionRouteInput;
  subagents?: Record<string, SessionRouteInput>;
  /** Compatibility alias for subagents. */
  roles?: Record<string, SessionRouteInput>;
  agentRoles?: Record<string, { description: string; instructions: string }>;
  store?: HostProviderStore;
  paths?: CprPaths;
  cprHome?: string;
  codexHomesDir?: string;
  usage?: HostUsageTarget;
  usageLedger?: HostUsageTarget;
  managedCredentialStore?: ManagedCredentialStore;
  credentialStore?: ManagedCredentialStore;
  hopCredentials?: ManagedCredentialStore;
  managedCredentialPath?: string;
  managedCredentialsPath?: string;
  hopCredentialsFile?: string;
  credentialTtlMs?: number;
  credentialExpiresAt?: number;
  now?: () => number;
  proxyBaseUrl?: string;
  port?: number;
  claudeProxyPath?: string;
  codexProxyPath?: string;
  modelPrefix?: string;
  baseEnv?: NodeJS.ProcessEnv;
  /** Compatibility alias for baseEnv. */
  env?: NodeJS.ProcessEnv;
}

export interface PreparedSessionRouting {
  env: NodeJS.ProcessEnv;
  credential: ManagedRouteCredential;
  routes: PreparedSessionRoute[];
  proxy: {
    store: HostProviderStore;
    getProvider(appType: 'claude' | 'codex', providerId: string): Provider | null;
    hopCredentials: ManagedCredentialStore;
    requireHopCredential: true;
    onUsageEvent?: (event: UsageEvent) => unknown;
    claudeProxyPath?: string;
    codexProxyPath?: string;
    modelPrefix?: string;
  };
  revoke(reason?: string): { revoked: number; revokedAt?: number; alreadyRevoked?: boolean };
}

export function prepareSessionRouting(options: PrepareSessionRoutingOptions): PreparedSessionRouting;
