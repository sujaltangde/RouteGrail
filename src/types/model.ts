import type { Tier } from "./provider.js";

/** A canonical model family and the ID patterns that map onto it. */
export type Family = {
  id: string;
  tier: Tier;
  patterns: RegExp[];
};

export type DiscoveredModel = {
  /** Provider-native model ID, used verbatim on the wire. */
  id: string;
  provider: string;
  family: string;
  tier: Tier;
  contextWindow?: number;
};
