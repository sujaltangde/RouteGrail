import type { DiscoveredModel } from "./model.js";

export type DiscoveryResult = {
  models: DiscoveredModel[];
  /** Set when the provider must be taken out of rotation for this session. */
  disabled?: { reason: string };
  degraded?: boolean;
};
