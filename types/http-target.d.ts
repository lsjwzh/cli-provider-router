import type { AppType, Provider } from './index';

export type HttpProtocol = 'anthropic' | 'openai';
export type HttpWireApi = 'messages' | 'responses' | 'chat_completions';

export interface HttpTargetOptions {
  protocol?: HttpProtocol | AppType;
  claudeProxyPath?: string;
  codexProxyPath?: string;
  mountPath?: string;
  localProxyPaths?: readonly string[];
}

export interface HttpTargetResolution {
  available: boolean;
  protocol: HttpProtocol | '';
  reason?: string;
  wireApi?: HttpWireApi;
  url?: string;
  /** Sensitive upstream credential; callers must not log or serialize it. */
  apiKey?: string;
  /** Header convention for apiKey. */
  authMode?: 'bearer' | 'x-api-key';
  model?: string;
  modelOptions?: string[];
  providerName?: string;
}

export const DEFAULT_LOCAL_PROXY_PATHS: readonly string[];
export function isLocalProxyUrl(value: string, options?: HttpTargetOptions): boolean;
export function resolveHttpTarget(provider: Provider, options?: HttpTargetOptions): HttpTargetResolution;
export function resolveHttpTarget(protocol: HttpProtocol | AppType, provider: Provider, options?: HttpTargetOptions): HttpTargetResolution;
export function resolveHttpTarget(
  store: { getProvider(appType: AppType, providerId: string): Provider | null },
  appType: AppType,
  providerId: string,
  options?: HttpTargetOptions,
): HttpTargetResolution;
