import { ApiClient } from "../src/api/client.js";
import type { Config, Credentials } from "../src/config.js";
import { GraphqlClient } from "../src/api/graphql.js";

export interface MockResult {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}

export type MockHandler = (body: {
  query: string;
  variables?: Record<string, unknown>;
}) => MockResult | Promise<MockResult>;

function toResponse(result: MockResult): Response {
  const status = result.status ?? 200;
  const headers = new Headers(result.headers ?? { "Content-Type": "application/json" });
  const text = result.json !== undefined ? JSON.stringify(result.json) : "";
  return new Response(text, { status, headers });
}

/**
 * Build a `fetch` that answers GraphQL POSTs from a handler, bypassing the network
 * entirely. Honors an AbortSignal the way the real `fetch` would, so tests can
 * exercise GraphqlClient's timeout handling with a handler that never resolves.
 */
export function mockFetch(handler: MockHandler): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables?: Record<string, unknown> };
    const signal = init?.signal;
    const settled = Promise.resolve().then(() => handler(body));

    if (!signal) return toResponse(await settled);

    return new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      settled.then(
        (result) => {
          signal.removeEventListener("abort", onAbort);
          resolve(toResponse(result));
        },
        (err: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }) as typeof fetch;
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { hasCredentials: false, cartWritesEnabled: false, ...overrides };
}

export function loggedInConfig(overrides: Partial<Config> = {}): Config {
  const credentials: Credentials = { email: "test@example.com", password: "hunter2" };
  return { hasCredentials: true, cartWritesEnabled: false, credentials, ...overrides };
}

export interface MakeClientOptions {
  config?: Config;
  minIntervalMs?: number;
  maxConcurrent?: number;
  timeoutMs?: number;
}

/** Build an ApiClient wired to a scriptable mock GraphQL backend — no network I/O. */
export function makeClient(handler: MockHandler, opts: MakeClientOptions = {}): ApiClient {
  const graphql = new GraphqlClient({
    fetchImpl: mockFetch(handler),
    minIntervalMs: opts.minIntervalMs ?? 0,
    maxConcurrent: opts.maxConcurrent ?? 10,
    timeoutMs: opts.timeoutMs ?? 2000,
  });
  return new ApiClient(opts.config ?? testConfig(), { graphqlClient: graphql });
}

export function graphqlOk(data: unknown): MockResult {
  return { json: { data } };
}

export function graphqlErrors(errors: { message: string; category?: string }[], data: unknown = null): MockResult {
  return {
    json: {
      data,
      errors: errors.map((e) => ({ message: e.message, extensions: e.category ? { category: e.category } : undefined })),
    },
  };
}
