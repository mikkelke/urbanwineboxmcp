import type { Config } from "../config.js";
import { UwbAuthenticationError } from "./errors.js";
import { GraphqlClient, unwrap, type GraphqlClientOptions, type GraphqlResponse } from "./graphql.js";
import { Session } from "./session.js";

/**
 * Single chokepoint for talking to the urbanwinebox.com GraphQL API: owns the
 * GraphQL transport, the login session, and the cart-mutation mutex. Catalog calls
 * are always anonymous; customer/cart calls log in lazily and retry once, reactively,
 * on a graphql-authentication error (the token expired or was never valid) — never
 * on any other failure, since that would risk resending a mutation that already
 * landed server-side.
 */
export class ApiClient {
  readonly graphql: GraphqlClient;
  readonly session: Session;
  private cartLock: Promise<unknown> = Promise.resolve();

  constructor(config: Config, opts: { graphqlClient?: GraphqlClient; graphqlOptions?: GraphqlClientOptions } = {}) {
    this.graphql = opts.graphqlClient ?? new GraphqlClient(opts.graphqlOptions);
    this.session = new Session(config, this.graphql);
  }

  get hasCredentials(): boolean {
    return this.session.isLoginMode;
  }

  /** Anonymous read query. Used by catalog browsing — never sends an auth header. */
  async publicQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await this.graphql.query<T>(query, variables);
    return unwrap(res);
  }

  /** Authenticated read query. Requires credentials; refreshes the token reactively once. */
  async customerQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    this.session.requireLogin();
    return this.withReactiveAuth((headers) => this.graphql.query<T>(query, variables, { headers }));
  }

  /** Authenticated mutation. Requires credentials; refreshes the token reactively once. */
  async customerMutate<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    this.session.requireLogin();
    return this.withReactiveAuth((headers) => this.graphql.mutate<T>(query, variables, { headers }));
  }

  /**
   * Run `fn` with exclusive access to the cart: queued behind any other cart
   * mutation on this client so two concurrent tool calls (e.g. two add_to_cart)
   * can't race on cart id resolution or item state.
   */
  withCartLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.cartLock.then(fn, fn);
    // Swallow rejections here so one failed mutation doesn't wedge the queue for
    // the next caller; the real result/error is still returned by `run` below.
    this.cartLock = run.catch(() => {});
    return run;
  }

  private async withReactiveAuth<T>(run: (headers: Record<string, string>) => Promise<GraphqlResponse<T>>): Promise<T> {
    await this.session.ensureToken();
    try {
      return unwrap(await run(await this.session.authHeaders()));
    } catch (err) {
      if (!(err instanceof UwbAuthenticationError)) throw err;
      // A graphql-authentication error means the auth middleware rejected the
      // request before any resolver ran, so the original call never mutated
      // anything — safe to refresh the token and resend exactly once.
      this.session.invalidateToken();
      await this.session.ensureToken();
      return unwrap(await run(await this.session.authHeaders()));
    }
  }
}
