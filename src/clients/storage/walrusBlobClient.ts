import type { Logger } from '../../types.js';

interface WalrusBlobClientOptions {
  publisherUrl: string;
  aggregatorUrl: string;
  epochs: number;
  logger: Logger;
}

export interface StoredBlob {
  blobId: string;
  /** Aggregator URL where the blob can be read back. */
  url: string;
  /** True when the publisher minted a fresh blob (vs. an already-certified one). */
  newlyCreated: boolean;
}

interface PublisherStoreResponse {
  newlyCreated?: {
    blobObject?: {
      blobId?: string;
    };
  };
  alreadyCertified?: {
    blobId?: string;
  };
}

/**
 * Thin HTTP client for the Walrus publisher/aggregator REST API.
 *
 * Uses the public testnet endpoints by default, so no funded Sui/WAL wallet is
 * required to demo verifiable, content-addressed persistence.
 */
export class WalrusBlobClient {
  private readonly publisherUrl: string;
  private readonly aggregatorUrl: string;
  private readonly epochs: number;
  private readonly logger: Logger;

  constructor({ publisherUrl, aggregatorUrl, epochs, logger }: WalrusBlobClientOptions) {
    this.publisherUrl = trimTrailingSlash(publisherUrl);
    this.aggregatorUrl = trimTrailingSlash(aggregatorUrl);
    this.epochs = epochs;
    this.logger = logger;
  }

  blobUrl(blobId: string): string {
    return `${this.aggregatorUrl}/v1/blobs/${blobId}`;
  }

  /** Store raw bytes on Walrus and return the content-addressed blob id. */
  async storeBlob(bytes: Uint8Array, opts: { epochs?: number } = {}): Promise<StoredBlob> {
    const epochs = opts.epochs ?? this.epochs;
    const url = `${this.publisherUrl}/v1/blobs?epochs=${epochs}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes as unknown as BodyInit
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Walrus publisher returned HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    let parsed: PublisherStoreResponse;
    try {
      parsed = JSON.parse(text) as PublisherStoreResponse;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Walrus publisher returned non-JSON response: ${message}`);
    }

    const newBlobId = parsed.newlyCreated?.blobObject?.blobId;
    const certifiedBlobId = parsed.alreadyCertified?.blobId;
    const blobId = newBlobId ?? certifiedBlobId;
    if (!blobId) {
      throw new Error('Walrus publisher response did not include a blobId');
    }

    this.logger.info('Stored blob on Walrus', { blobId, newlyCreated: Boolean(newBlobId), epochs });
    return { blobId, url: this.blobUrl(blobId), newlyCreated: Boolean(newBlobId) };
  }

  /** Store a UTF-8 string on Walrus. */
  async storeString(value: string, opts: { epochs?: number } = {}): Promise<StoredBlob> {
    return this.storeBlob(new TextEncoder().encode(value), opts);
  }

  /** Read raw bytes for a blob id from the aggregator. */
  async readBlob(blobId: string): Promise<Uint8Array> {
    const response = await fetch(this.blobUrl(blobId));
    if (!response.ok) {
      throw new Error(`Walrus aggregator returned HTTP ${response.status} for blob ${blobId}`);
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  /** Read a blob id and decode it as a UTF-8 string. */
  async readString(blobId: string): Promise<string> {
    const bytes = await this.readBlob(blobId);
    return new TextDecoder().decode(bytes);
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
