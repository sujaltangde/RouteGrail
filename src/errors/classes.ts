import type { AttemptRecord, ErrorClass, Skipped } from "../types/index.js";

export class RouteGrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteGrailError";
  }
}

export class ProviderError extends RouteGrailError {
  constructor(
    public readonly provider: string,
    public readonly model: string,
    public readonly errorClass: ErrorClass,
    public readonly status: number | undefined,
    message: string,
    public readonly retryAfterMs?: number,
    public readonly body?: string,
  ) {
    super(`[${provider}/${model}] ${errorClass}: ${message}`);
    this.name = "ProviderError";
  }
}

export class AllProvidersFailedError extends RouteGrailError {
  constructor(
    public readonly trail: AttemptRecord[],
    public readonly skipped: Skipped[],
  ) {
    const attempted = trail.length
      ? trail.map((a) => `${a.provider}/${a.model} → ${a.errorClass ?? "?"}`).join("; ")
      : "no provider was eligible";
    super(
      `All providers failed. Attempted: ${attempted}. ` +
        `Skipped ${skipped.length} route(s). Inspect .trail and .skipped for detail.`,
    );
    this.name = "AllProvidersFailedError";
  }
}

export class NoRouteError extends RouteGrailError {
  constructor(
    public readonly skipped: Skipped[],
    detail: string,
  ) {
    super(`No eligible route: ${detail}`);
    this.name = "NoRouteError";
  }
}

export class ConfigError extends RouteGrailError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
