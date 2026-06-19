import { afterEach, describe, expect, test } from 'bun:test';
import { XClient } from '../src/clients/http/xClient.js';
import type { Logger } from '../src/types.js';

const originalFetch = globalThis.fetch;
const logger = quietLogger();

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('XClient', () => {
  test('createPost sends a v2 tweet create request and returns post data', async () => {
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;

    globalThis.fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
      requestedUrl = String(url);
      requestedInit = init;
      return new Response(JSON.stringify({ data: { id: '1885', text: 'Treasury update' } }), {
        status: 201
      });
    }) as unknown as typeof fetch;

    const client = new XClient({
      apiBase: 'https://api.x.com',
      userAccessToken: 'user-token',
      logger
    });

    const post = await client.createPost('Treasury update');

    expect(post).toEqual({ id: '1885', text: 'Treasury update' });
    expect(requestedUrl).toBe('https://api.x.com/2/tweets');
    expect(requestedInit?.method).toBe('POST');
    expect(requestedInit?.headers).toEqual({
      accept: 'application/json',
      authorization: 'Bearer user-token',
      'content-type': 'application/json'
    });
    expect(requestedInit?.body).toBe(JSON.stringify({ text: 'Treasury update' }));
  });
});

function quietLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
