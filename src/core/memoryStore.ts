import fs from 'node:fs';
import path from 'node:path';
import type { WalrusBlobClient } from '../clients/walrusBlobClient.js';
import type { AppConfig, Logger } from '../types.js';
import {
  createEmptyAgentState,
  normalizeAgentState,
  resolveAgentStatePath,
  saveAgentState,
  type AgentStateV1
} from './agentMemory.js';

export interface SaveOptions {
  /**
   * When true, push the state durably to Walrus (network write). When false,
   * only the fast local cache is updated. Defaults to true.
   */
  durable?: boolean;
}

export interface MemoryStore {
  load(): Promise<AgentStateV1>;
  save(state: AgentStateV1, opts?: SaveOptions): Promise<void>;
}

/** Local JSON file persistence — the original behavior. */
export class FileMemoryStore implements MemoryStore {
  constructor(
    private readonly config: AppConfig,
    private readonly statePath: string
  ) {}

  async load(): Promise<AgentStateV1> {
    if (!fs.existsSync(this.statePath)) {
      return createEmptyAgentState(this.config);
    }

    const raw = fs.readFileSync(this.statePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AgentStateV1>;
    return normalizeAgentState(this.config, parsed) ?? createEmptyAgentState(this.config);
  }

  async save(state: AgentStateV1): Promise<void> {
    saveAgentState(this.statePath, state);
  }
}

interface WalrusPointer {
  blobId: string;
  url: string;
  walletAddress: string;
  updatedAt: string;
}

/**
 * Walrus-backed persistence. Every durable save uploads the full agent state as
 * a content-addressed blob and records the latest blob id in a local pointer
 * file. State can be restored/ported onto a fresh machine via WALRUS_STATE_BLOB_ID.
 *
 * A local file cache mirrors every save so the agent stays fast and resilient:
 * non-durable saves only touch the cache, and any Walrus outage falls back to it.
 */
export class WalrusMemoryStore implements MemoryStore {
  private readonly cache: FileMemoryStore;
  private readonly pointerPath: string;

  constructor(
    private readonly config: AppConfig,
    private readonly blobClient: WalrusBlobClient,
    private readonly logger: Logger,
    private readonly statePath: string
  ) {
    this.cache = new FileMemoryStore(config, statePath);
    this.pointerPath = path.resolve(path.dirname(statePath), 'walrus-pointer.json');
  }

  async load(): Promise<AgentStateV1> {
    const blobId = this.resolveBlobId();
    if (blobId) {
      try {
        const raw = await this.blobClient.readString(blobId);
        const parsed = JSON.parse(raw) as Partial<AgentStateV1>;
        const normalized = normalizeAgentState(this.config, parsed);
        if (normalized) {
          this.logger.info('Loaded agent state from Walrus', { blobId });
          // Refresh the local cache so subsequent non-durable saves are coherent.
          saveAgentState(this.statePath, normalized);
          return normalized;
        }

        this.logger.warn('Walrus state blob was incompatible; resetting', { blobId });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn('Failed to load state from Walrus; falling back to local cache', {
          blobId,
          error: message
        });
      }
    }

    return this.cache.load();
  }

  async save(state: AgentStateV1, opts: SaveOptions = {}): Promise<void> {
    const durable = opts.durable ?? true;

    // Always keep the local cache current (cheap, synchronous).
    await this.cache.save(state);

    if (!durable) {
      return;
    }

    try {
      const stored = await this.blobClient.storeString(JSON.stringify(state));
      this.writePointer({
        blobId: stored.blobId,
        url: stored.url,
        walletAddress: state.walletAddress,
        updatedAt: state.updatedAt
      });
      this.logger.info('Persisted agent state to Walrus', { blobId: stored.blobId, url: stored.url });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // Never fail a run because of a storage hiccup; the local cache still holds the state.
      this.logger.warn('Failed to persist state to Walrus; kept local cache', { error: message });
    }
  }

  latestBlobId(): string | null {
    return this.resolveBlobId();
  }

  private resolveBlobId(): string | null {
    const pointer = this.readPointer();
    if (pointer?.blobId && (!pointer.walletAddress || pointer.walletAddress === this.config.agent.walletAddress.toLowerCase())) {
      return pointer.blobId;
    }

    const fromEnv = this.config.walrus.stateBlobId.trim();
    return fromEnv ? fromEnv : null;
  }

  private readPointer(): WalrusPointer | null {
    if (!fs.existsSync(this.pointerPath)) {
      return null;
    }

    try {
      return JSON.parse(fs.readFileSync(this.pointerPath, 'utf8')) as WalrusPointer;
    } catch {
      return null;
    }
  }

  private writePointer(pointer: WalrusPointer): void {
    fs.mkdirSync(path.dirname(this.pointerPath), { recursive: true });
    fs.writeFileSync(this.pointerPath, JSON.stringify(pointer, null, 2));
  }
}

export function createMemoryStore({
  config,
  blobClient,
  logger
}: {
  config: AppConfig;
  blobClient: WalrusBlobClient;
  logger: Logger;
}): MemoryStore {
  const statePath = resolveAgentStatePath(config);
  if (config.walrus.memoryBackend === 'walrus') {
    return new WalrusMemoryStore(config, blobClient, logger, statePath);
  }

  return new FileMemoryStore(config, statePath);
}
