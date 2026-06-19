import { afterEach, describe, expect, test } from 'bun:test';
import { WalrusBlobClient } from '../src/clients/storage/walrusBlobClient.js';
import { createLogger } from '../src/utils/logger.js';

const logger = createLogger('error');
const publisherUrl = 'https://publisher.example';
const aggregatorUrl = 'https://aggregator.example';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function client(): WalrusBlobClient {
  return new WalrusBlobClient({ publisherUrl, aggregatorUrl, epochs: 3, logger });
}

describe('WalrusBlobClient', () => {
  test('storeString parses newlyCreated blob id and builds aggregator url', async () => {
    let seenUrl = '';
    let seenMethod = '';
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenMethod = init?.method ?? 'GET';
      return new Response(JSON.stringify({ newlyCreated: { blobObject: { blobId: 'BLOB_A' } } }), {
        status: 200
      });
    }) as unknown as typeof fetch;

    const stored = await client().storeString('hello world');

    expect(seenMethod).toBe('PUT');
    expect(seenUrl).toBe(`${publisherUrl}/v1/blobs?epochs=3`);
    expect(stored.blobId).toBe('BLOB_A');
    expect(stored.newlyCreated).toBe(true);
    expect(stored.url).toBe(`${aggregatorUrl}/v1/blobs/BLOB_A`);
  });

  test('storeString accepts alreadyCertified responses', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ alreadyCertified: { blobId: 'BLOB_B' } }), {
        status: 200
      })) as unknown as typeof fetch;

    const stored = await client().storeString('dup');
    expect(stored.blobId).toBe('BLOB_B');
    expect(stored.newlyCreated).toBe(false);
  });

  test('storeString throws on non-2xx publisher response', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    await expect(client().storeString('x')).rejects.toThrow(/HTTP 500/);
  });

  test('readString round-trips through the aggregator', async () => {
    let seenUrl = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
      seenUrl = String(url);
      return new Response('the-payload', { status: 200 });
    }) as unknown as typeof fetch;

    const text = await client().readString('BLOB_A');
    expect(seenUrl).toBe(`${aggregatorUrl}/v1/blobs/BLOB_A`);
    expect(text).toBe('the-payload');
  });
});
