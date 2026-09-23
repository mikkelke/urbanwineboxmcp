import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchProductBySku, getAttributeOptions, getWineByUrl, getWineByUrlKey, getWineBySku, searchWines } from "../src/api/catalog.js";
import { UwbNotFoundError, UwbValidationError } from "../src/api/errors.js";
import { barolo2017, countryOptions, soldOutWine, wineTypeOptions } from "./fixtures/products.js";
import { graphqlOk, makeClient } from "./testUtils.js";

const baseParams = {
  in_stock_only: true,
  sort: "relevance" as const,
  sort_direction: "ASC" as const,
  page: 1,
  page_size: 20,
};

describe("searchWines", () => {
  it("maps a search response into WineSummary items", async () => {
    const client = makeClient((body) => {
      if (body.query.includes("query SearchWines")) {
        return graphqlOk({
          products: {
            total_count: 1,
            page_info: { current_page: 1, page_size: 20, total_pages: 1 },
            items: [barolo2017],
          },
        });
      }
      throw new Error(`unexpected query: ${body.query}`);
    });

    const result = await searchWines(client, { ...baseParams, query: "barolo" });
    assert.equal(result.total_count, 1);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.sku, barolo2017.sku);
    assert.equal(result.approximate, false);
    assert.deepEqual(result.notes, []);
  });

  it("resolves a wine_type label to its option id before filtering", async () => {
    let sentFilter: unknown;
    const client = makeClient((body) => {
      if (body.query.includes("query AttributeMetadata")) {
        const code = (body.variables?.attributes as { attribute_code: string }[])[0]?.attribute_code;
        const options = code === "wine_type" ? wineTypeOptions : [];
        return graphqlOk({ customAttributeMetadataV2: { errors: [], items: [{ code, options }] } });
      }
      if (body.query.includes("query SearchWines")) {
        sentFilter = body.variables?.filter;
        return graphqlOk({
          products: { total_count: 0, page_info: { current_page: 1, page_size: 20, total_pages: 0 }, items: [] },
        });
      }
      throw new Error(`unexpected query: ${body.query}`);
    });

    await searchWines(client, { ...baseParams, wine_type: "red wine" });
    assert.deepEqual(sentFilter, { wine_type: { eq: "22858" } });
  });

  it("throws a validation error when a label has no match", async () => {
    const client = makeClient((body) => {
      if (body.query.includes("query AttributeMetadata")) {
        return graphqlOk({
          customAttributeMetadataV2: { errors: [], items: [{ code: "country", options: countryOptions }] },
        });
      }
      throw new Error(`unexpected query: ${body.query}`);
    });

    await assert.rejects(
      () => searchWines(client, { ...baseParams, country: "Narnia" }),
      UwbValidationError,
    );
  });

  it("folds producer into free-text search and notes the approximation", async () => {
    let sentSearch: unknown;
    const client = makeClient((body) => {
      if (body.query.includes("query SearchWines")) {
        sentSearch = body.variables?.search;
        return graphqlOk({
          products: { total_count: 0, page_info: { current_page: 1, page_size: 20, total_pages: 0 }, items: [] },
        });
      }
      throw new Error(`unexpected query: ${body.query}`);
    });

    const result = await searchWines(client, { ...baseParams, producer: "Bartolo Mascarello" });
    assert.equal(sentSearch, "Bartolo Mascarello");
    assert.equal(result.approximate, true);
    assert.ok(result.notes.some((n) => n.includes("approximate")));
  });

  it("drops results whose vintage doesn't match client-side and notes it", async () => {
    const wrongVintage = { ...barolo2017, sku: "OTHER_GROUPED" };
    wrongVintage.custom_attributesV2 = {
      items: barolo2017.custom_attributesV2.items.map((a) => (a.code === "year" ? { code: "year", value: "2016" } : a)),
    };
    const client = makeClient((body) => {
      if (body.query.includes("query SearchWines")) {
        return graphqlOk({
          products: {
            total_count: 2,
            page_info: { current_page: 1, page_size: 20, total_pages: 1 },
            items: [barolo2017, wrongVintage],
          },
        });
      }
      throw new Error(`unexpected query: ${body.query}`);
    });

    const result = await searchWines(client, { ...baseParams, vintage: 2017 });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.sku, barolo2017.sku);
    assert.ok(result.notes.some((n) => n.includes("vintage")));
  });

  it("drops sold-out results when in_stock_only is true and notes it", async () => {
    const client = makeClient((body) => {
      if (body.query.includes("query SearchWines")) {
        return graphqlOk({
          products: {
            total_count: 2,
            page_info: { current_page: 1, page_size: 20, total_pages: 1 },
            items: [barolo2017, soldOutWine],
          },
        });
      }
      throw new Error(`unexpected query: ${body.query}`);
    });

    const result = await searchWines(client, { ...baseParams, in_stock_only: true });
    assert.equal(result.items.length, 1);
    assert.ok(result.notes.some((n) => n.includes("no lots listed")));
  });
});

describe("getAttributeOptions caching", () => {
  it("only fetches an attribute's options once within the TTL", async () => {
    let calls = 0;
    const client = makeClient((body) => {
      if (body.query.includes("query AttributeMetadata")) {
        calls++;
        return graphqlOk({ customAttributeMetadataV2: { errors: [], items: [{ code: "country", options: countryOptions }] } });
      }
      throw new Error(`unexpected query: ${body.query}`);
    });

    await getAttributeOptions(client, "country");
    await getAttributeOptions(client, "country");
    assert.equal(calls, 1);
  });
});

describe("fetchProductBySku / getWineBySku", () => {
  it("returns undefined for an unknown sku", async () => {
    const client = makeClient((body) => {
      if (body.query.includes("query ProductByFilter")) return graphqlOk({ products: { items: [] } });
      throw new Error(`unexpected query: ${body.query}`);
    });
    assert.equal(await fetchProductBySku(client, "nope"), undefined);
  });

  it("rejects a malformed/unknown sku with UwbNotFoundError", async () => {
    const client = makeClient((body) => {
      if (body.query.includes("query ProductByFilter")) return graphqlOk({ products: { items: [] } });
      throw new Error(`unexpected query: ${body.query}`);
    });
    await assert.rejects(() => getWineBySku(client, "not-a-real-sku"), UwbNotFoundError);
  });

  it("rejects a lot (child) sku with UwbValidationError instead of returning it", async () => {
    // A child sku is never returned by the products(filter: {sku}) query (children aren't
    // individually searchable), so the server-side behavior is identical to "unknown sku":
    // it surfaces as not-found, which is itself the correct signal to try get_wine on the parent.
    const client = makeClient((body) => {
      if (body.query.includes("query ProductByFilter")) return graphqlOk({ products: { items: [] } });
      throw new Error(`unexpected query: ${body.query}`);
    });
    await assert.rejects(() => getWineBySku(client, "LOT-CHEAP"), UwbNotFoundError);
  });

  it("rejects a non-grouped product with UwbValidationError", async () => {
    const simple = { ...barolo2017, __typename: "SimpleProduct" };
    const client = makeClient((body) => {
      if (body.query.includes("query ProductByFilter")) return graphqlOk({ products: { items: [simple] } });
      throw new Error(`unexpected query: ${body.query}`);
    });
    await assert.rejects(() => getWineBySku(client, simple.sku), UwbValidationError);
  });

  it("returns a WineDetail for a real parent sku", async () => {
    const client = makeClient((body) => {
      if (body.query.includes("query ProductByFilter")) return graphqlOk({ products: { items: [barolo2017] } });
      throw new Error(`unexpected query: ${body.query}`);
    });
    const detail = await getWineBySku(client, barolo2017.sku);
    assert.equal(detail.sku, barolo2017.sku);
    assert.equal(detail.lots.length, 2);
  });
});

describe("getWineByUrlKey / getWineByUrl", () => {
  it("looks up by url_key", async () => {
    const client = makeClient((body) => {
      if (body.query.includes("query ProductByFilter")) {
        assert.deepEqual(body.variables?.filter, { url_key: { eq: barolo2017.url_key } });
        return graphqlOk({ products: { items: [barolo2017] } });
      }
      throw new Error(`unexpected query: ${body.query}`);
    });
    const detail = await getWineByUrlKey(client, barolo2017.url_key);
    assert.equal(detail.sku, barolo2017.sku);
  });

  it("strips domain and appends .html for route lookups", async () => {
    let sentUrl: unknown;
    const client = makeClient((body) => {
      if (body.query.includes("query WineRoute")) {
        sentUrl = body.variables?.url;
        return graphqlOk({ route: barolo2017 });
      }
      throw new Error(`unexpected query: ${body.query}`);
    });
    const detail = await getWineByUrl(client, `https://urbanwinebox.com/${barolo2017.url_key}`);
    assert.equal(sentUrl, `${barolo2017.url_key}.html`);
    assert.equal(detail.sku, barolo2017.sku);
  });

  it("rejects a route that isn't a product", async () => {
    const client = makeClient((body) => {
      if (body.query.includes("query WineRoute")) return graphqlOk({ route: { __typename: "CmsPage" } });
      throw new Error(`unexpected query: ${body.query}`);
    });
    await assert.rejects(() => getWineByUrl(client, "some-cms-page"), UwbValidationError);
  });
});
