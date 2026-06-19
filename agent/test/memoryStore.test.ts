import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WalrusBlobClient } from '../src/clients/storage/walrusBlobClient.js';
import { createEmptyAgentState } from '../src/core/agentMemory.js';
import { FileMemoryStore, WalrusMemoryStore } from '../src/core/memoryStore.js';
import type { AppConfig } from '../src/types.js';
import { createLogger } from '../src/utils/logger.js';

const logger = createLogger('error');

function makeConfig(overrides: { stateBlobId?: string } = {}): AppConfig {
  return {
    agent: {
      name: 'TestAgent',
      walletAddress: '0x0000000000000000000000000000000000000001',
      mission: 'test',
      statePath: '',
      depositCooldownMs: 0
    },
    walrus: {
      memoryBackend: 'walrus',
      publisherUrl: 'https://publisher.example',
      aggregatorUrl: 'https://aggregator.example',
      epochs: 5,
      stateBlobId: overrides.stateBlobId ?? '',
      memwal: { enabled: false, accountId: '', delegateKey: '', relayerUrl: '', namespace: 'defi-agent' }
    }
  } as unknown as AppConfig;
}

/** In-memory stand-in for the Walrus publisher/aggregator. */
class FakeBlobClient {
  readonly store = new Map<string, string>();
  uploads = 0;
  private seq = 0;

  async storeString(value: string) {
    this.uploads += 1;
    this.seq += 1;
    const blobId = `blob-${this.seq}`;
    this.store.set(blobId, value);
    return { blobId, url: `agg/${blobId}`, newlyCreated: true };
  }

  async storeBlob(bytes: Uint8Array) {
    return this.storeString(new TextDecoder().decode(bytes));
  }

  async readString(blobId: string) {
    const value = this.store.get(blobId);
    if (value === undefined) {
      throw new Error(`blob not found: ${blobId}`);
    }
    return value;
  }

  async readBlob(blobId: string) {
    return new TextEncoder().encode(await this.readString(blobId));
  }

  blobUrl(blobId: string) {
    return `agg/${blobId}`;
  }
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function tempStatePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memstore-'));
  tempDirs.push(dir);
  return path.join(dir, 'agent-state.json');
}

describe('WalrusMemoryStore', () => {
  test('durable save uploads to Walrus and reload reads it back via the pointer', async () => {
    const config = makeConfig();
    const blob = new FakeBlobClient();
    const statePath = tempStatePath();
    const store = new WalrusMemoryStore(config, blob as unknown as WalrusBlobClient, logger, statePath);

    const state = createEmptyAgentState(config);
    state.runs.unshift({ runId: 'run-1', startedAt: '2026-01-01T00:00:00.000Z' });
    await store.save(state, { durable: true });

    expect(blob.uploads).toBe(1);
    expect(store.latestBlobId()).toBe('blob-1');

    // A fresh store instance (no in-memory state) should rehydrate from Walrus.
    const reloadStore = new WalrusMemoryStore(config, blob as unknown as WalrusBlobClient, logger, statePath);
    const reloaded = await reloadStore.load();
    expect(reloaded.runs[0]?.runId).toBe('run-1');
  });

  test('non-durable save updates local cache only (no upload)', async () => {
    const config = makeConfig();
    const blob = new FakeBlobClient();
    const statePath = tempStatePath();
    const store = new WalrusMemoryStore(config, blob as unknown as WalrusBlobClient, logger, statePath);

    const state = createEmptyAgentState(config);
    await store.save(state, { durable: false });

    expect(blob.uploads).toBe(0);
    expect(fs.existsSync(statePath)).toBe(true);
  });

  test('bootstraps from WALRUS_STATE_BLOB_ID when no pointer exists', async () => {
    const blob = new FakeBlobClient();
    // Seed a blob directly, as if it were stored on a previous machine.
    const seedConfig = makeConfig();
    const seedState = createEmptyAgentState(seedConfig);
    seedState.runs.unshift({ runId: 'ported-run', startedAt: '2026-01-01T00:00:00.000Z' });
    const { blobId } = await blob.storeString(JSON.stringify(seedState));

    const config = makeConfig({ stateBlobId: blobId });
    const store = new WalrusMemoryStore(config, blob as unknown as WalrusBlobClient, logger, tempStatePath());
    const loaded = await store.load();
    expect(loaded.runs[0]?.runId).toBe('ported-run');
  });

  test('falls back to empty state when Walrus read fails', async () => {
    const config = makeConfig({ stateBlobId: 'missing-blob' });
    const blob = new FakeBlobClient();
    const store = new WalrusMemoryStore(config, blob as unknown as WalrusBlobClient, logger, tempStatePath());
    const loaded = await store.load();
    expect(loaded.version).toBe(1);
    expect(loaded.runs).toEqual([]);
  });
});

describe('FileMemoryStore', () => {
  test('save then load round-trips state', async () => {
    const config = makeConfig();
    const statePath = tempStatePath();
    const store = new FileMemoryStore(config, statePath);

    const state = createEmptyAgentState(config);
    state.runs.unshift({ runId: 'file-run', startedAt: '2026-01-01T00:00:00.000Z' });
    await store.save(state);

    const reloaded = await store.load();
    expect(reloaded.runs[0]?.runId).toBe('file-run');
  });
});
