/** Typed errors thrown by the API layer; tool handlers map these to MCP results. */

export class UwbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A GraphQL error with no more specific mapping (unknown/missing category). */
export class UwbGraphqlError extends UwbError {
  constructor(
    message: string,
    public readonly category?: string,
  ) {
    super(message);
  }
}

/** `graphql-authentication`: missing/expired/invalid bearer token, or bad login credentials. */
export class UwbAuthenticationError extends UwbGraphqlError {}

/** `graphql-authorization`: not logged in (or not permitted) for the requested field. */
export class UwbAuthorizationError extends UwbGraphqlError {}

/** `graphql-input`: the server rejected the input (e.g. qty exceeds the per-lot maximum). */
export class UwbInputError extends UwbGraphqlError {}

/** `graphql-no-such-entity`: unknown sku, cart item, category, etc. */
export class UwbNotFoundError extends UwbGraphqlError {}

/** Local input validation failure (cart guard, malformed tool arguments). */
export class UwbValidationError extends UwbError {}

/** Non-2xx HTTP response, or a 2xx body that isn't valid JSON. */
export class UwbHttpError extends UwbError {
  constructor(
    public readonly status: number,
    public readonly bodyExcerpt: string,
  ) {
    super(`HTTP ${status} from urbanwinebox.com/graphql: ${bodyExcerpt}`);
  }
}

/** Network/transport failure (DNS, connection, timeout, abort). */
export class UwbNetworkError extends UwbError {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

/**
 * A mutation's outcome could not be confirmed (network error/timeout after the
 * request was sent). Unlike a plain NetworkError, callers should tell the user to
 * verify state (e.g. via get_cart) rather than imply nothing happened.
 */
export class UwbAmbiguousMutationError extends UwbError {}
