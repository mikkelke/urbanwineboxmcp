import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  UwbAuthenticationError,
  UwbAuthorizationError,
  UwbGraphqlError,
  UwbHttpError,
  UwbInputError,
  UwbNetworkError,
  UwbNotFoundError,
} from "../src/api/errors.js";
import { GraphqlClient, unwrap } from "../src/api/graphql.js";
import { mockFetch } from "./testUtils.js";

describe("unwrap", () => {
  it("returns data when present, even alongside errors (partial data + errors)", () => {
    const data = unwrap({ data: { ok: true }, errors: [{ message: "a minor issue" }] });
    assert.deepEqual(data, { ok: true });
  });

  it("maps known extensions.category values to typed errors", () => {
    assert.throws(
      () => unwrap({ data: null, errors: [{ message: "m", extensions: { category: "graphql-authentication" } }] }),
      UwbAuthenticationError,
    );
    assert.throws(
      () => unwrap({ data: null, errors: [{ message: "m", extensions: { category: "graphql-authorization" } }] }),
      UwbAuthorizationError,
    );
    assert.throws(
      () => unwrap({ data: null, errors: [{ message: "m", extensions: { category: "graphql-input" } }] }),
      UwbInputError,
    );
    assert.throws(
      () => unwrap({ data: null, errors: [{ message: "m", extensions: { category: "graphql-no-such-entity" } }] }),
      UwbNotFoundError,
    );
  });

  it("falls back to a generic error when extensions/category are missing", () => {
    assert.throws(() => unwrap({ data: null, errors: [{ message: "Cannot query field x" }] }), UwbGraphqlError);
    assert.throws(() => unwrap({ data: null }), UwbGraphqlError);
  });
});

describe("GraphqlClient retries", () => {
  it("retries a read query once on 429, honoring Retry-After, then succeeds", async () => {
    let calls = 0;
    const start = Date.now();
    const client = new GraphqlClient({
      fetchImpl: mockFetch(() => {
        calls++;
        if (calls === 1) return { status: 429, headers: { "retry-after": "0.2" }, json: { errors: [{ message: "rate limited" }] } };
        return { json: { data: { ok: true } } };
      }),
      minIntervalMs: 0,
      maxConcurrent: 5,
    });

    const res = await client.query<{ ok: boolean }>("query { ok }");
    const elapsed = Date.now() - start;
    assert.equal(calls, 2);
    assert.deepEqual(res, { data: { ok: true } });
    assert.ok(elapsed >= 180, `expected the retry to honor Retry-After (~200ms); took ${elapsed}ms`);
  });

  it("retries a read query once on 5xx with a default backoff when Retry-After is absent", async () => {
    let calls = 0;
    const client = new GraphqlClient({
      fetchImpl: mockFetch(() => {
        calls++;
        if (calls === 1) return { status: 503, json: { errors: [{ message: "unavailable" }] } };
        return { json: { data: { ok: true } } };
      }),
      minIntervalMs: 0,
      maxConcurrent: 5,
    });
    const res = await client.query<{ ok: boolean }>("query { ok }");
    assert.equal(calls, 2);
    assert.deepEqual(res, { data: { ok: true } });
  });

  it("never retries a mutation, even on 429/5xx", async () => {
    let calls = 0;
    const client = new GraphqlClient({
      fetchImpl: mockFetch(() => {
        calls++;
        return { status: 429, json: { errors: [{ message: "rate limited" }] } };
      }),
      minIntervalMs: 0,
    });
    await assert.rejects(() => client.mutate("mutation { doThing }"), UwbHttpError);
    assert.equal(calls, 1);
  });

  it("gives up after one retry if the read query keeps failing", async () => {
    let calls = 0;
    const client = new GraphqlClient({
      fetchImpl: mockFetch(() => {
        calls++;
        return { status: 500, json: { errors: [{ message: "still down" }] } };
      }),
      minIntervalMs: 0,
    });
    await assert.rejects(() => client.query("query { ok }"), UwbHttpError);
    assert.equal(calls, 2);
  });
});

describe("GraphqlClient timeout", () => {
  it("aborts and throws UwbNetworkError when the server never responds", async () => {
    const client = new GraphqlClient({ fetchImpl: mockFetch(() => new Promise(() => {})), timeoutMs: 30, minIntervalMs: 0 });
    await assert.rejects(() => client.query("query { ok }"), UwbNetworkError);
  });
});

describe("GraphqlClient throttle", () => {
  it("never exceeds maxConcurrent in-flight requests", async () => {
    let active = 0;
    let maxActive = 0;
    const client = new GraphqlClient({
      fetchImpl: mockFetch(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        return { json: { data: { ok: true } } };
      }),
      minIntervalMs: 0,
      maxConcurrent: 2,
    });

    await Promise.all(Array.from({ length: 6 }, () => client.query("query { ok }")));
    assert.ok(maxActive <= 2, `expected at most 2 concurrent requests, saw ${maxActive}`);
  });

  it("waits at least minIntervalMs between request starts", async () => {
    const starts: number[] = [];
    const client = new GraphqlClient({
      fetchImpl: mockFetch(() => {
        starts.push(Date.now());
        return { json: { data: { ok: true } } };
      }),
      minIntervalMs: 30,
      maxConcurrent: 5,
    });

    await Promise.all(Array.from({ length: 3 }, () => client.query("query { ok }")));
    assert.equal(starts.length, 3);
    for (let i = 1; i < starts.length; i++) {
      const gap = starts[i]! - starts[i - 1]!;
      assert.ok(gap >= 25, `expected >=~30ms between request starts, got ${gap}ms`);
    }
  });
});
