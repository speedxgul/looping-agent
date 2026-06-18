import { MemWal } from '@mysten-incubation/memwal';
import type { Logger } from '../types.js';

interface WalrusMemoryClientOptions {
  enabled: boolean;
  accountId: string;
  delegateKey: string;
  relayerUrl: string;
  namespace: string;
  logger: Logger;
}

export interface RecalledMemory {
  text: string;
  /** Cosine distance (lower = more relevant). */
  distance: number;
  blobId: string;
}

/**
 * Wraps the MemWal (Walrus Memory) SDK to give the agent portable, verifiable
 * semantic memory across sessions and machines.
 *
 * All operations are best-effort: when disabled or misconfigured, or when the
 * relayer is unreachable, methods degrade to no-ops/empty results so a memory
 * outage never breaks an agent run.
 */
export class WalrusMemoryClient {
  private readonly logger: Logger;
  private readonly namespace: string;
  private readonly client: MemWal | null;
  private readonly disabledReason: string | null;

  constructor({ enabled, accountId, delegateKey, relayerUrl, namespace, logger }: WalrusMemoryClientOptions) {
    this.logger = logger;
    this.namespace = namespace;

    if (!enabled) {
      this.client = null;
      this.disabledReason = 'MEMWAL_ENABLED is false';
      return;
    }

    if (!accountId || !delegateKey) {
      this.client = null;
      this.disabledReason = 'MEMWAL_ACCOUNT_ID and MEMWAL_DELEGATE_KEY are required';
      logger.warn('Walrus Memory enabled but missing credentials; running without semantic memory');
      return;
    }

    try {
      this.client = MemWal.create({
        key: delegateKey,
        accountId,
        serverUrl: relayerUrl,
        namespace
      });
      this.disabledReason = null;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.client = null;
      this.disabledReason = message;
      logger.warn('Failed to initialize Walrus Memory client; running without semantic memory', { error: message });
    }
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  get reason(): string | null {
    return this.disabledReason;
  }

  async health(): Promise<{ ok: boolean; status?: string; version?: string; reason?: string }> {
    if (!this.client) {
      return { ok: false, reason: this.disabledReason ?? 'disabled' };
    }

    try {
      const result = await this.client.health();
      return { ok: true, status: result.status, version: result.version };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: message };
    }
  }

  /** Search for relevant memories. Returns [] when disabled or on error. */
  async recall(query: string, limit = 5): Promise<RecalledMemory[]> {
    if (!this.client || !query.trim()) {
      return [];
    }

    try {
      const result = await this.client.recall({ query, limit });
      return result.results.map((memory) => ({
        text: memory.text,
        distance: memory.distance,
        blobId: memory.blob_id
      }));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Walrus Memory recall failed', { error: message });
      return [];
    }
  }

  /**
   * Persist a memory. Returns the accepted job id (fire-and-forget) or null.
   * Set `wait` to block until the relayer finishes encoding + storing on Walrus.
   */
  async remember(text: string, opts: { wait?: boolean } = {}): Promise<string | null> {
    if (!this.client || !text.trim()) {
      return null;
    }

    try {
      if (opts.wait) {
        const result = await this.client.rememberAndWait(text);
        return result.job_id ?? null;
      }

      const accepted = await this.client.remember(text);
      return accepted.job_id ?? null;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Walrus Memory remember failed', { error: message });
      return null;
    }
  }

  /** Extract memorable facts from longer text and store them. Returns the number of facts queued. */
  async analyze(text: string): Promise<number> {
    if (!this.client || !text.trim()) {
      return 0;
    }

    try {
      const result = await this.client.analyze(text);
      return result.fact_count ?? result.job_ids.length;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Walrus Memory analyze failed', { error: message });
      return 0;
    }
  }
}
