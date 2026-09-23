import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getWineBySku, searchWines } from "../src/api/catalog.js";
import { ApiClient } from "../src/api/client.js";
import { testConfig } from "./testUtils.js";

/**
 * Hits the real urbanwinebox.com GraphQL API. Read-only: search + get_wine, both
 * anonymous. Never logs in and never calls a mutation — see AGENTS/plan constraints.
 * Skipped unless UWB_LIVE_TEST=1, since it depends on live catalog data and network access.
 */
const LIVE = process.env.UWB_LIVE_TEST === "1";

describe("live urbanwinebox.com smoke", { skip: LIVE ? false : "set UWB_LIVE_TEST=1 to run" }, () => {
  it("searches for barolo and fetches one returned wine's detail", async () => {
    const client = new ApiClient(testConfig());

    const result = await searchWines(client, {
      query: "barolo",
      in_stock_only: true,
      sort: "relevance",
      sort_direction: "ASC",
      page: 1,
      page_size: 5,
    });

    assert.ok(result.items.length > 0, "expected at least one live barolo result");
    const first = result.items[0]!;
    assert.ok(first.sku.length > 0);
    assert.ok(first.name.length > 0);

    const detail = await getWineBySku(client, first.sku);
    assert.equal(detail.sku, first.sku);
    assert.ok(Array.isArray(detail.lots));
  });
});
