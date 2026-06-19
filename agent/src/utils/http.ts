interface RequestJsonOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  retries?: number;
  retryDelayMs?: number;
}

interface HttpError extends Error {
  status?: number;
  payload?: unknown;
}

export async function requestJson<T = unknown>(url: string, options: RequestJsonOptions = {}): Promise<T> {
  const { method = 'GET', headers = {}, body, retries = 2, retryDelayMs = 500 } = options;

  // Only retry idempotent reads. Retrying a POST/PUT after a network error or 5xx can
  // double-submit a request the server already processed (e.g. a duplicate tweet/Walrus blob).
  const idempotent = method === 'GET' || method === 'HEAD';

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          ...headers
        },
        body
      });

      const text = await response.text();
      const payload = text ? parseJson(text, url) : null;

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} for ${url}`) as HttpError;
        error.status = response.status;
        error.payload = payload;
        throw error;
      }

      return payload as T;
    } catch (error) {
      lastError = error;
      if (attempt === retries || !idempotent || !isRetryable(error)) {
        throw error;
      }
      await sleep(retryDelayMs * 2 ** attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function withQuery(baseUrl: string, path: string, params: Record<string, unknown>): string {
  const url = new URL(path, ensureTrailingSlash(baseUrl));
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

export function joinUrl(baseUrl: string, path: string): string {
  return new URL(path.replace(/^\//, ''), ensureTrailingSlash(baseUrl)).toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function parseJson(text: string, url: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON from ${url}: ${message}`);
  }
}

function isRetryable(error: unknown): boolean {
  const status = error instanceof Error ? (error as HttpError).status : undefined;
  if (status === undefined) {
    return true;
  }

  return status === 408 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
