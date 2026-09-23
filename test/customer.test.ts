import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCart, getOrderDetails, getOrders, getWishlist } from "../src/api/customer.js";
import { UwbAuthenticationError, UwbNotFoundError } from "../src/api/errors.js";
import { cartLine, rawCart } from "./fixtures/cart.js";
import { graphqlOk, loggedInConfig, makeClient, testConfig } from "./testUtils.js";

const rawOrder = {
  number: "1000001",
  order_date: "2026-01-05 10:00:00",
  status: "Complete",
  total: { grand_total: { value: 1500, currency: "DKK" } },
  items: [
    { product_sku: "LOT-CHEAP", product_name: "Barolo &quot;Brunate&quot; 2017", quantity_ordered: 1, product_sale_price: { value: 1500, currency: "DKK" } },
  ],
};

describe("customer tools require login", () => {
  it("getOrders throws without credentials, before any request", async () => {
    const client = makeClient(() => {
      throw new Error("no requests expected");
    }, { config: testConfig() });
    await assert.rejects(() => getOrders(client, 1, 10), UwbAuthenticationError);
  });
});

describe("getOrders / getOrderDetails", () => {
  it("maps a page of orders", async () => {
    const client = makeClient((body) => {
      if (body.query.includes("mutation Login")) return graphqlOk({ generateCustomerToken: { token: "tok" } });
      if (body.query.includes("query GetOrders")) {
        return graphqlOk({
          customer: {
            orders: {
              total_count: 1,
              page_info: { current_page: 1, page_size: 10, total_pages: 1 },
              items: [rawOrder],
            },
          },
        });
      }
      throw new Error(`unexpected query: ${body.query}`);
    }, { config: loggedInConfig() });

    const result = await getOrders(client, 1, 10);
    assert.equal(result.total_count, 1);
    assert.equal(result.orders[0]?.number, "1000001");
    assert.equal(result.orders[0]?.total, 1500);
  });

  it("returns full line items for one order, with entities decoded", async () => {
    const client = makeClient((body) => {
      if (body.query.includes("mutation Login")) return graphqlOk({ generateCustomerToken: { token: "tok" } });
      if (body.query.includes("query GetOrderByNumber")) {
        assert.equal(body.variables?.number, "1000001");
        return graphqlOk({ customer: { orders: { items: [rawOrder] } } });
      }
      throw new Error(`unexpected query: ${body.query}`);
    }, { config: loggedInConfig() });

    const detail = await getOrderDetails(client, "1000001");
    assert.equal(detail.items[0]?.name, 'Barolo "Brunate" 2017');
    assert.equal(detail.items[0]?.sku, "LOT-CHEAP");
  });

  it("throws UwbNotFoundError for an unknown order number", async () => {
    const client = makeClient((body) => {
      if (body.query.includes("mutation Login")) return graphqlOk({ generateCustomerToken: { token: "tok" } });
      if (body.query.includes("query GetOrderByNumber")) return graphqlOk({ customer: { orders: { items: [] } } });
      throw new Error(`unexpected query: ${body.query}`);
    }, { config: loggedInConfig() });

    await assert.rejects(() => getOrderDetails(client, "does-not-exist"), UwbNotFoundError);
  });
});

describe("getWishlist", () => {
  it("maps the first wishlist's items", async () => {
    const client = makeClient((body) => {
      if (body.query.includes("mutation Login")) return graphqlOk({ generateCustomerToken: { token: "tok" } });
      if (body.query.includes("query GetWishlist")) {
        return graphqlOk({
          customer: {
            wishlists: [
              {
                id: "1",
                items_count: 1,
                items_v2: {
                  items: [
                    {
                      id: "wi1",
                      quantity: 1,
                      added_at: "2026-01-01",
                      description: null,
                      product: { sku: "a1_GROUPED", name: "Chianti", price_range: { minimum_price: { final_price: { value: 300, currency: "DKK" } } } },
                    },
                  ],
                },
              },
            ],
          },
        });
      }
      throw new Error(`unexpected query: ${body.query}`);
    }, { config: loggedInConfig() });

    const result = await getWishlist(client);
    assert.equal(result.items_count, 1);
    assert.equal(result.items[0]?.sku, "a1_GROUPED");
    assert.equal(result.items[0]?.price, 300);
  });

  it("returns an empty result when the account has no wishlist yet", async () => {
    const client = makeClient((body) => {
      if (body.query.includes("mutation Login")) return graphqlOk({ generateCustomerToken: { token: "tok" } });
      if (body.query.includes("query GetWishlist")) return graphqlOk({ customer: { wishlists: [] } });
      throw new Error(`unexpected query: ${body.query}`);
    }, { config: loggedInConfig() });

    assert.deepEqual(await getWishlist(client), { items: [], items_count: 0 });
  });
});

describe("getCart", () => {
  it("shapes the cart, including a cart_url and any per-line errors", async () => {
    const client = makeClient((body) => {
      if (body.query.includes("mutation Login")) return graphqlOk({ generateCustomerToken: { token: "tok" } });
      if (body.query.includes("query GetCart")) {
        return graphqlOk({
          customerCart: rawCart([cartLine({ errors: [{ message: "This lot just sold out." }] })]),
        });
      }
      throw new Error(`unexpected query: ${body.query}`);
    }, { config: loggedInConfig() });

    const cart = await getCart(client);
    assert.equal(cart.lines.length, 1);
    assert.deepEqual(cart.lines[0]?.errors, ["This lot just sold out."]);
    assert.ok(cart.cart_url.startsWith("https://urbanwinebox.com/"));
    assert.ok(cart.note.toLowerCase().includes("browser") || cart.note.toLowerCase().includes("checkout"));
  });
});
