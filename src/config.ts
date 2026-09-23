import { z } from "zod";

export const GRAPHQL_ENDPOINT = "https://urbanwinebox.com/graphql";
export const MEDIA_BASE_URL = "https://media.urbanwinebox.com";
export const CART_URL = "https://urbanwinebox.com/checkout/cart/";
export const USER_AGENT = "urbanwineboxmcp/0.1.0 (+https://github.com/mikkelke/urbanwineboxmcp)";

// Treat empty/whitespace-only values as "not provided" so an env var set to ""
// means anonymous mode rather than a validation error.
const optionalNonEmpty = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().min(1).optional(),
);

const truthyFlag = z.preprocess(
  (v) => (typeof v === "string" ? ["1", "true", "yes"].includes(v.trim().toLowerCase()) : Boolean(v)),
  z.boolean(),
);

const envSchema = z.object({
  URBANWINEBOX_EMAIL: optionalNonEmpty,
  URBANWINEBOX_PASSWORD: optionalNonEmpty,
  URBANWINEBOX_ENABLE_CART_WRITES: truthyFlag.optional().default(false),
});

export interface Credentials {
  email: string;
  password: string;
}

export interface Config {
  /** Present only when both email and password are provided. */
  credentials?: Credentials;
  /** Convenience flag: true when credentials are available (login mode). */
  hasCredentials: boolean;
  /** True only when URBANWINEBOX_ENABLE_CART_WRITES is set truthy. */
  cartWritesEnabled: boolean;
}

/** Parse and validate configuration from the process environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse({
    URBANWINEBOX_EMAIL: env.URBANWINEBOX_EMAIL,
    URBANWINEBOX_PASSWORD: env.URBANWINEBOX_PASSWORD,
    URBANWINEBOX_ENABLE_CART_WRITES: env.URBANWINEBOX_ENABLE_CART_WRITES,
  });

  const credentials =
    parsed.URBANWINEBOX_EMAIL && parsed.URBANWINEBOX_PASSWORD
      ? { email: parsed.URBANWINEBOX_EMAIL, password: parsed.URBANWINEBOX_PASSWORD }
      : undefined;

  return {
    credentials,
    hasCredentials: !!credentials,
    cartWritesEnabled: parsed.URBANWINEBOX_ENABLE_CART_WRITES === true,
  };
}
