import type { AppType, Provider, ProviderSummary } from './index';

export type ModelPolicyProvider =
  | Provider
  | ProviderSummary
  | (Partial<Provider> & Partial<ProviderSummary>);

export interface ResolveWireModelOptions {
  providerModel?: string | null;
  providerModels?: readonly string[] | null;
  skipDefaultModel?: boolean;
  defaultModel?: string | null;
}

export function stripModelSuffix(model?: unknown): string;
export function modelValidForProvider(
  appType: AppType | string,
  provider: ModelPolicyProvider | null | undefined,
  model?: string | null,
): boolean;
export function modelValidForProvider(
  model: string | null | undefined,
  provider: ModelPolicyProvider | null | undefined,
): boolean;
export const validateModel: typeof modelValidForProvider;
export function resolveWireModel(
  sessionModel?: string | null,
  options?: ResolveWireModelOptions,
): string | null;
