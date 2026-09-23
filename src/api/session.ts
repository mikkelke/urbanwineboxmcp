import type { Config, Credentials } from "../config.js";
import { logger } from "../logger.js";
import { UwbAuthenticationError } from "./errors.js";
import { GraphqlClient, unwrap } from "./graphql.js";

const LOGIN_MUTATION = `
  mutation Login($email: String!, $password: String!) {
    generateCustomerToken(email: $email, password: $password) {
      token
    }
  }
`;

interface LoginResponse {
  generateCustomerToken: { token: string };
}

/** Refresh the token this long after it was issued (server TTL is unconfirmed; refresh well ahead of it). */
const REFRESH_AFTER_MS = 50 * 60 * 1000;

/**
 * Owns login state for the process: the bearer token, its age, and whether
 * credentials have already been proven invalid.
 *
 * Anonymous mode (no credentials) never calls generateCustomerToken; every
 * customer/cart tool call fails fast via requireLogin().
 */
export class Session {
  private token?: string;
  private tokenIssuedAt = 0;
  private invalidCredentials = false;

  /** Mutex so concurrent tool calls share a single in-flight login attempt. */
  private inFlight?: Promise<void>;

  constructor(
    private readonly config: Config,
    private readonly graphql: GraphqlClient,
  ) {}

  get isLoginMode(): boolean {
    return this.config.hasCredentials;
  }

  /** Throw a clear error unless credentials are configured (customer/cart tools). */
  requireLogin(): void {
    if (!this.isLoginMode) {
      throw new UwbAuthenticationError(
        "This action requires login. Set URBANWINEBOX_EMAIL and URBANWINEBOX_PASSWORD to use this tool.",
      );
    }
  }

  private hasFreshToken(): boolean {
    return !!this.token && Date.now() - this.tokenIssuedAt < REFRESH_AFTER_MS;
  }

  /** Headers for an authenticated request. Logs in first if needed. */
  async authHeaders(): Promise<Record<string, string>> {
    if (!this.isLoginMode) return {};
    await this.ensureToken();
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  /** Ensure a fresh token is held, logging in (or waiting on a concurrent login) as needed. */
  async ensureToken(): Promise<void> {
    if (!this.isLoginMode || this.hasFreshToken()) return;

    if (this.invalidCredentials) {
      throw new UwbAuthenticationError(
        "Login previously failed: urbanwinebox.com rejected these credentials. Fix " +
          "URBANWINEBOX_EMAIL/URBANWINEBOX_PASSWORD and restart the server to try again.",
      );
    }

    if (this.inFlight) {
      await this.inFlight;
      return;
    }

    this.inFlight = this.login();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  /** Force the next ensureToken() to re-authenticate (used on a graphql-authentication error). */
  invalidateToken(): void {
    this.tokenIssuedAt = 0;
  }

  private async login(): Promise<void> {
    const creds = this.config.credentials as Credentials;
    try {
      const res = await this.graphql.mutate<LoginResponse>(LOGIN_MUTATION, {
        email: creds.email,
        password: creds.password,
      });
      const data = unwrap(res);
      this.token = data.generateCustomerToken.token;
      this.tokenIssuedAt = Date.now();
      logger.info("session: logged in");
    } catch (err) {
      if (err instanceof UwbAuthenticationError) {
        this.invalidCredentials = true;
        logger.error("session: login rejected, latching until restart", { error: err.message });
      }
      throw err;
    }
  }
}
