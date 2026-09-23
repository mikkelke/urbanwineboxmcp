import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { UwbAuthenticationError } from "../src/api/errors.js";
import { graphqlErrors, graphqlOk, loggedInConfig, makeClient } from "./testUtils.js";

describe("Session.requireLogin", () => {
  it("throws clearly when no credentials are configured", () => {
    const client = makeClient(() => {
      throw new Error("no requests expected");
    });
    assert.throws(() => client.session.requireLogin(), UwbAuthenticationError);
  });

  it("does not throw when credentials are configured", () => {
    const client = makeClient(() => {
      throw new Error("no requests expected");
    }, { config: loggedInConfig() });
    assert.doesNotThrow(() => client.session.requireLogin());
  });
});

describe("Session.ensureToken", () => {
  it("logs in once and reuses the token on subsequent calls", async () => {
    let logins = 0;
    const client = makeClient((body) => {
      if (body.query.includes("mutation Login")) {
        logins++;
        return graphqlOk({ generateCustomerToken: { token: "tok-1" } });
      }
      throw new Error(`unexpected query: ${body.query}`);
    }, { config: loggedInConfig() });

    await client.session.ensureToken();
    await client.session.ensureToken();
    assert.equal(logins, 1);
    assert.deepEqual(await client.session.authHeaders(), { Authorization: "Bearer tok-1" });
  });

  it("shares one in-flight login across concurrent callers (login mutex)", async () => {
    let logins = 0;
    let releaseLogin: (() => void) | undefined;
    const client = makeClient(async (body) => {
      if (body.query.includes("mutation Login")) {
        logins++;
        await new Promise<void>((resolve) => {
          releaseLogin = resolve;
        });
        return graphqlOk({ generateCustomerToken: { token: "tok-1" } });
      }
      throw new Error(`unexpected query: ${body.query}`);
    }, { config: loggedInConfig() });

    const p1 = client.session.ensureToken();
    const p2 = client.session.ensureToken();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(logins, 1, "second caller must not start its own login mutation");
    releaseLogin?.();
    await Promise.all([p1, p2]);
    assert.equal(logins, 1);
  });

  it("latches invalid credentials after the first rejection, never retrying", async () => {
    let attempts = 0;
    const client = makeClient((body) => {
      if (body.query.includes("mutation Login")) {
        attempts++;
        return graphqlErrors([
          { message: "The account sign-in was incorrect or your account is disabled temporarily.", category: "graphql-authentication" },
        ]);
      }
      throw new Error(`unexpected query: ${body.query}`);
    }, { config: loggedInConfig() });

    await assert.rejects(() => client.session.ensureToken(), UwbAuthenticationError);
    await assert.rejects(() => client.session.ensureToken(), UwbAuthenticationError);
    assert.equal(attempts, 1, "a second call must fail fast from the latch, not attempt another login");
  });

  it("refreshes the token after the refresh window elapses", async (t: TestContext) => {
    let logins = 0;
    const client = makeClient((body) => {
      if (body.query.includes("mutation Login")) {
        logins++;
        return graphqlOk({ generateCustomerToken: { token: `tok-${logins}` } });
      }
      throw new Error(`unexpected query: ${body.query}`);
    }, { config: loggedInConfig() });

    t.mock.timers.enable({ apis: ["Date"] });
    await client.session.ensureToken();
    assert.equal(logins, 1);

    await client.session.ensureToken();
    assert.equal(logins, 1, "must not refresh before the window elapses");

    t.mock.timers.tick(51 * 60 * 1000);
    await client.session.ensureToken();
    assert.equal(logins, 2, "must refresh once the window elapses");
  });
});

describe("ApiClient reactive re-auth", () => {
  it("refreshes the token once on a graphql-authentication error and retries the call", async () => {
    let logins = 0;
    let attempts = 0;
    const client = makeClient((body) => {
      if (body.query.includes("mutation Login")) {
        logins++;
        return graphqlOk({ generateCustomerToken: { token: `tok-${logins}` } });
      }
      if (body.query.includes("query Probe")) {
        attempts++;
        if (attempts === 1) {
          return graphqlErrors([{ message: "Composite reader could not read a token", category: "graphql-authentication" }]);
        }
        return graphqlOk({ probe: true });
      }
      throw new Error(`unexpected query: ${body.query}`);
    }, { config: loggedInConfig() });

    const result = await client.customerQuery<{ probe: boolean }>("query Probe { probe }");
    assert.deepEqual(result, { probe: true });
    assert.equal(logins, 2, "initial login plus exactly one reactive re-login");
    assert.equal(attempts, 2);
  });

  it("never retries more than once, even if authentication keeps failing", async () => {
    let logins = 0;
    const client = makeClient((body) => {
      if (body.query.includes("mutation Login")) {
        logins++;
        return graphqlOk({ generateCustomerToken: { token: `tok-${logins}` } });
      }
      if (body.query.includes("query Probe")) {
        return graphqlErrors([{ message: "still bad", category: "graphql-authentication" }]);
      }
      throw new Error(`unexpected query: ${body.query}`);
    }, { config: loggedInConfig() });

    await assert.rejects(() => client.customerQuery("query Probe { probe }"), UwbAuthenticationError);
    assert.equal(logins, 2, "must stop after the initial login plus one reactive retry");
  });
});
