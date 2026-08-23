import {
  AllProvidersFailedError,
  classifyHttp,
  classifyThrown,
  consumesQuota,
  cooldownMs,
  shouldCascade,
} from "../errors/index.js";
import { harvestHeaders, mine429 } from "../quota/harvester.js";
import { estimateRequestTokens } from "../quota/tokens.js";
import { isFailure } from "../transport/openai.js";
import type {
  AttemptRecord,
  ErrorClass,
  ExecutorDeps,
  GenerateRequest,
  GenerateResponse,
  ProviderConfig,
  ProviderRuntime,
  Route,
  Skipped,
} from "../types/index.js";
import { ewma } from "../utils/index.js";

export class Executor {
  constructor(private readonly deps: ExecutorDeps) {}

  private runtimeFor(id: string): ProviderRuntime {
    let rt = this.deps.runtime.get(id);
    if (!rt) {
      rt = { successes: 0, failures: 0 };
      this.deps.runtime.set(id, rt);
    }
    return rt;
  }

  /** Acquire a concurrency slot when the provider gates on concurrency, not rate. */
  private async acquireSlot(provider: ProviderConfig): Promise<boolean> {
    if (provider.maxConcurrent === undefined) return true;
    return this.deps.store.acquire(`sem:${provider.id}`, provider.maxConcurrent);
  }

  private async releaseSlot(provider: ProviderConfig): Promise<void> {
    if (provider.maxConcurrent === undefined) return;
    await this.deps.store.release(`sem:${provider.id}`);
  }

  /** Ingest whatever the provider disclosed. Runs on success AND failure. */
  private async harvest(
    provider: ProviderConfig,
    modelId: string,
    headers: Headers,
    body?: string,
  ): Promise<number | undefined> {
    let retryAfterMs: number | undefined;

    const fromHeaders = harvestHeaders(provider, headers);
    if (fromHeaders) {
      await this.deps.ledger.ingest(provider, modelId, fromHeaders);
      retryAfterMs = fromHeaders.retryAfterMs;
    }
    if (body) {
      const mined = mine429(body);
      if (mined) {
        await this.deps.ledger.ingest(provider, modelId, mined);
        retryAfterMs = retryAfterMs ?? mined.retryAfterMs;
      }
    }
    return retryAfterMs;
  }

  private applyFailure(
    provider: ProviderConfig,
    cls: ErrorClass,
    retryAfterMs: number | undefined,
    detail: string,
  ): void {
    const rt = this.runtimeFor(provider.id);
    rt.failures += 1;

    switch (cls) {
      case "AUTH":
        rt.disabled = `auth_failed: ${detail.slice(0, 160)}`;
        break;
      case "REGION_BLOCKED":
        rt.disabled = `region_blocked: free tier unavailable in ${(provider.regionBlocked ?? ["this region"]).join("/")}`;
        break;
      default: {
        const ms = cooldownMs(cls, retryAfterMs);
        if (ms > 0) rt.cooldownUntil = Date.now() + ms;
      }
    }
  }

  /**
   * Run the attempt loop. Every attempt reserves quota before sending, then
   * commits it with real usage or rolls it back if the provider never metered it.
   */
  async run(
    request: GenerateRequest,
    routes: Route[],
    skipped: Skipped[],
    maxAttempts: number,
  ): Promise<GenerateResponse> {
    const trail: AttemptRecord[] = [];
    const estTokens = estimateRequestTokens(request.prompt, request.system);

    for (const route of routes.slice(0, maxAttempts)) {
      const { provider, model } = route;
      const creds = this.deps.credentials.get(provider.id) ?? {};
      const started = Date.now();

      const gotSlot = await this.acquireSlot(provider);
      if (!gotSlot) {
        skipped.push({ provider: provider.id, model: model.id, reason: "concurrency_full" });
        continue;
      }

      const reservation = await this.deps.ledger.reserve(provider, model.id, estTokens);

      try {
        const res = await this.deps.transport.chat(provider, creds, model.id, request);
        const latencyMs = Date.now() - started;

        // ---------------------------------------------------------------
        if (isFailure(res)) {
          const cls = classifyHttp(res.status, res.body);
          const retryAfterMs = await this.harvest(provider, model.id, res.headers, res.body);

          if (consumesQuota(cls)) {
            await this.deps.ledger.commit(reservation, undefined);
          } else {
            await this.deps.ledger.rollback(reservation);
          }

          if (cls === "QUOTA_EXHAUSTED") {
            await this.deps.ledger.exhaust(provider, model.id, "day");
          }
          if (cls === "MODEL_NOT_FOUND") {
            // The catalog is stale. Refresh it so the next call sees real IDs.
            await this.deps.onModelNotFound(provider.id);
          }

          this.applyFailure(provider, cls, retryAfterMs, res.body);
          trail.push({
            provider: provider.id,
            model: model.id,
            errorClass: cls,
            status: res.status,
            message: res.body.slice(0, 300),
            latencyMs,
          });

          this.deps.log("warn", `attempt failed ${provider.id}/${model.id}`, {
            class: cls,
            status: res.status,
          });

          // A malformed request is the caller's problem, not a capacity one —
          // cascading it burns a dozen quotas for the same error.
          if (!shouldCascade(cls)) break;
          continue;
        }

        // ---------------------------------------------------------------
        await this.harvest(provider, model.id, res.headers);
        await this.deps.ledger.commit(reservation, res.usage?.totalTokens);

        const rt = this.runtimeFor(provider.id);
        rt.successes += 1;
        rt.latencyMs = ewma(rt.latencyMs, latencyMs);
        rt.cooldownUntil = undefined;

        if (request.sessionId) {
          await this.deps.onAffinity(request.sessionId, model.family);
        }

        return {
          text: res.text,
          provider: provider.id,
          model: model.id,
          family: model.family,
          usage: res.usage,
          latencyMs,
          routing: {
            attempts: trail.length + 1,
            fallbackUsed: trail.length > 0,
            skipped,
            trail,
          },
        };
      } catch (err) {
        const latencyMs = Date.now() - started;
        const cls = classifyThrown(err);

        // Never reached the provider's meter — give the quota back.
        await this.deps.ledger.rollback(reservation);
        this.applyFailure(provider, cls, undefined, String(err));

        trail.push({
          provider: provider.id,
          model: model.id,
          errorClass: cls,
          message: String((err as Error)?.message ?? err).slice(0, 300),
          latencyMs,
        });

        if (request.signal?.aborted) throw err;
      } finally {
        await this.releaseSlot(provider);
      }
    }

    throw new AllProvidersFailedError(trail, skipped);
  }
}
