import type { Tier } from "./provider.js";
import type { LedgerSource } from "./quota.js";

export type ProviderState = "healthy" | "degraded" | "exhausted" | "cooldown" | "disabled";

export type QuotaStatus = {
  source: LedgerSource;
  remainingMinute?: number;
  remainingDay?: number;
  remainingMonth?: number;
  remainingTokensMinute?: number;
  resetInMs?: number;
};

export type ProviderStatus = {
  state: ProviderState;
  reason?: string;
  discovered?: number;
  quota?: QuotaStatus;
  latencyMsEwma?: number;
  successRate?: number;
};

/** How many providers can serve a family, and how many are live right now. */
export type FamilyStatus = {
  routes: number;
  available: number;
  tier: Tier;
};

export type StatusReport = {
  providers: Record<string, ProviderStatus>;
  families: Record<string, FamilyStatus>;
  generatedAt: string;
};
