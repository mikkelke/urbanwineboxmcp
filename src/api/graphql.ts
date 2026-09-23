import { GRAPHQL_ENDPOINT, USER_AGENT } from "../config.js";
import { logger } from "../logger.js";
import {
  UwbAuthenticationError,
  UwbAuthorizationError,
  UwbGraphqlError,
  UwbHttpError,
  UwbInputError,
  UwbNetworkError,
  UwbNotFoundError,
} from "./errors.js";

export interface GraphqlErrorEntry {
  message: string;
  path?: (string | number)[];
  extensions?: { category?: string; [key: string]: unknown };
}

export interface GraphqlResponse<T> {
  data: T | null;
  errors?: GraphqlErrorEntry[];
}

export interface GraphqlCallOptions {
  headers?: Record<string, string>;
}

export interface GraphqlClientOptions {
  endpoint?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  minIntervalMs?: number;
  maxConcurrent?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MIN_INTERVAL_MS = 250;
const DEFAULT_MAX_CONCURRENT = 2;

/** Maps a GraphQL error's `extensions.category` to a typed exception class. */
function errorFromEntries(entries: GraphqlErrorEntry[] | undefined): UwbGraphqlError {
  const first = entries?.[0];
  const message = first?.message ?? "Unknown GraphQL error";
  const category = first?.extensions?.category;
  switch (category) {
    case "graphql-authentication":
      return new UwbAuthenticationError(message, category);
    case "graphql-authorization":
      return new UwbAuthorizationError(message, category);
    case "graphql-input":
      return new UwbInputError(message, category);
    case "graphql-no-such-entity":
      return new UwbNotFoundError(message, category);
    default:
      return new UwbGraphqlError(message, category);
  }
}

/** Returns `data`, or throws the typed error built from `errors` when `data` is missing. */
export function unwrap<T>(res: GraphqlResponse<T>): T {
  if (res.data !== null && res.data !== undefined) return res.data;
  throw errorFromEntries(res.errors);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serializes requests to at most `maxConcurrent` in flight, with at least
 * `minIntervalMs` between request starts. A courtesy to a single shared endpoint,
 * not a rate limit imposed by the server.
 */
class Throttle {
  private lastStart = 0;
  private active = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly maxConcurrent: number,
  ) {}

  async acquire(): Promise<() => void> {
    for (;;) {
      const wait = Math.max(0, this.lastStart + this.minIntervalMs - Date.now());
      if (this.active < this.maxConcurrent && wait === 0) {
        this.active++;
        this.lastStart = Date.now();
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.active--;
        };
      }
      await sleep(Math.max(wait, 1));
    }
  }
}

type Outcome<T> =
  | { type: "ok"; body: GraphqlResponse<T> }
  | { type: "http"; status: number; bodyExcerpt: string; retryAfterMs: number }
  | { type: "network"; message: string; cause?: unknown };

/**
 * Thin GraphQL client over `fetch`: single endpoint, JSON in/out, a shared
 * concurrency+interval throttle, a request timeout, and — for read queries only —
 * a single retry on 429/5xx honoring Retry-After. Mutations are never retried here:
 * a resend after a timeout or 5xx cannot tell whether the original write already
 * landed server-side.
 */
export class GraphqlClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly throttle: Throttle;

  constructor(opts: GraphqlClientOptions = {}) {
    this.endpoint = opts.endpoint ?? GRAPHQL_ENDPOINT;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.throttle = new Throttle(
      opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
      opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    );
  }

  /** Read query: eligible for a single retry on 429/5xx. */
  query<T>(query: string, variables?: Record<string, unknown>, opts: GraphqlCallOptions = {}): Promise<GraphqlResponse<T>> {
    return this.request<T>(query, variables, opts.headers, true);
  }

  /** Mutation: never retried by this layer — see class doc. */
  mutate<T>(query: string, variables?: Record<string, unknown>, opts: GraphqlCallOptions = {}): Promise<GraphqlResponse<T>> {
    return this.request<T>(query, variables, opts.headers, false);
  }

  private async request<T>(
    query: string,
    variables: Record<string, unknown> | undefined,
    headers: Record<string, string> | undefined,
    retryable: boolean,
  ): Promise<GraphqlResponse<T>> {
    let outcome = await this.attempt<T>(query, variables, headers);

    if (retryable && outcome.type === "http" && (outcome.status === 429 || outcome.status >= 500)) {
      logger.warn("graphql: retrying read query once", { status: outcome.status, waitMs: outcome.retryAfterMs });
      await sleep(outcome.retryAfterMs);
      outcome = await this.attempt<T>(query, variables, headers);
    }

    if (outcome.type === "network") throw new UwbNetworkError(outcome.message, outcome.cause);
    if (outcome.type === "http") throw new UwbHttpError(outcome.status, outcome.bodyExcerpt);
    return outcome.body;
  }

  private async attempt<T>(
    query: string,
    variables: Record<string, unknown> | undefined,
    headers: Record<string, string> | undefined,
  ): Promise<Outcome<T>> {
    const release = await this.throttle.acquire();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": USER_AGENT,
            ...headers,
          },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === "AbortError";
        return {
          type: "network",
          message: timedOut
            ? `Timed out after ${this.timeoutMs}ms requesting urbanwinebox.com/graphql`
            : `Network error requesting urbanwinebox.com/graphql: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        };
      } finally {
        clearTimeout(timer);
      }

      const text = await response.text();
      if (response.status < 200 || response.status >= 300) {
        const retryAfter = Number(response.headers.get("retry-after"));
        return {
          type: "http",
          status: response.status,
          bodyExcerpt: text.slice(0, 500),
          retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000,
        };
      }

      try {
        return { type: "ok", body: text === "" ? { data: null } : (JSON.parse(text) as GraphqlResponse<T>) };
      } catch {
        return { type: "http", status: response.status, bodyExcerpt: `Invalid JSON: ${text.slice(0, 200)}`, retryAfterMs: 1000 };
      }
    } finally {
      release();
    }
  }
}
