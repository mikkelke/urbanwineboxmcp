import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addToCart, removeFromCart } from "../src/api/cart.js";
import { UwbAmbiguousMutationError, UwbNotFoundError, UwbValidationError } from "../src/api/errors.js";
import { barolo2017 } from "./fixtures/products.js";
import { cartLine, rawCart } from "./fixtures/cart.js";
import { graphqlOk, loggedInConfig, makeClient, type MockHandler } from "./testUtils.js";

/** Every customerQuery/customerMutate call logs in first; stub that once, up front, for handlers that don't care about it. */
function withLogin(fn: MockHandler): MockHandler {
  return (body) => {
    if (body.query.includes("mutation Login")) return graphqlOk({ generateCustomerToken: { token: "tok" } });
    return fn(body);
  };
}

describe("addToCart guard", () => {
  it("rejects a parent (_GROUPED) sku passed as lot_sku before any network call", async () => {
    const client = makeClient(() => {
      throw new Error("should not make any request");
    }, { config: loggedInConfig() });
    await assert.rejects(
      () => addToCart(client, barolo2017.sku, "SOMETHING_GROUPED"),
      UwbValidationError,
    );
  });

  it("rejects an unknown parent sku", async () => {
    const client = makeClient((body) => {
      if (body.query.includes("query ProductByFilter")) return graphqlOk({ products: { items: [] } });
      throw new Error(`unexpected query: ${body.query}`);
    }, { config: loggedInConfig() });
    await assert.rejects(() => addToCart(client, "NOPE_GROUPED", "LOT-CHEAP"), UwbNotFoundError);
  });

  it("rejects a lot that isn't currently among the parent's children", async () => {
    const client = makeClient((body) => {
      if (body.query.includes("query ProductByFilter")) return graphqlOk({ products: { items: [barolo2017] } });
      throw new Error(`unexpected query: ${body.query}`);
    }, { config: loggedInConfig() });
    await assert.rejects(() => addToCart(client, barolo2017.sku, "LOT-DOES-NOT-EXIST"), UwbValidationError);
  });

  it("rejects a child whose own type isn't SimpleProduct", async () => {
    const weird = {
      ...barolo2017,
      items: [{ ...barolo2017.items![0]!, product: { ...barolo2017.items![0]!.product, __typename: "VirtualProduct" } }],
    };
    const client = makeClient((body) => {
      if (body.query.includes("query ProductByFilter")) return graphqlOk({ products: { items: [weird] } });
      throw new Error(`unexpected query: ${body.query}`);
    }, { config: loggedInConfig() });
    await assert.rejects(() => addToCart(client, barolo2017.sku, "LOT-EXPENSIVE"), UwbValidationError);
  });

  it("adds a valid lot and reports it present in the returned cart", async () => {
    const client = makeClient(withLogin((body) => {
      if (body.query.includes("query ProductByFilter")) return graphqlOk({ products: { items: [barolo2017] } });
      if (body.query.includes("query GetCartId")) return graphqlOk({ customerCart: { id: "cart-1" } });
      if (body.query.includes("mutation AddLotToCart")) {
        assert.equal(body.variables?.sku, "LOT-CHEAP");
        assert.equal(body.variables?.cartId, "cart-1");
        return graphqlOk({ addSimpleProductsToCart: { cart: rawCart([cartLine({ uid: "u1", product: { sku: "LOT-CHEAP", name: "Barolo" } })]) } });
      }
      throw new Error(`unexpected query: ${body.query}`);
    }), { config: loggedInConfig() });

    const result = await addToCart(client, barolo2017.sku, "LOT-CHEAP");
    assert.equal(result.now_in_cart, true);
    assert.equal(result.added_sku, "LOT-CHEAP");
    assert.equal(result.lines.length, 1);
    assert.ok(result.cart_url.includes("urbanwinebox.com"));
  });

  it("surfaces a network failure during the mutation as an ambiguous-outcome error", async () => {
    const client = makeClient(withLogin((body) => {
      if (body.query.includes("query ProductByFilter")) return graphqlOk({ products: { items: [barolo2017] } });
      if (body.query.includes("query GetCartId")) return graphqlOk({ customerCart: { id: "cart-1" } });
      if (body.query.includes("mutation AddLotToCart")) throw new Error("simulated connection reset");
      throw new Error(`unexpected query: ${body.query}`);
    }), { config: loggedInConfig() });

    await assert.rejects(() => addToCart(client, barolo2017.sku, "LOT-CHEAP"), UwbAmbiguousMutationError);
  });

  it("serializes concurrent add_to_cart calls so their requests never overlap", async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const client = makeClient(withLogin(async (body) => {
      inFlight++;
      maxObserved = Math.max(maxObserved, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (body.query.includes("query ProductByFilter")) return graphqlOk({ products: { items: [barolo2017] } });
        if (body.query.includes("query GetCartId")) return graphqlOk({ customerCart: { id: "cart-1" } });
        if (body.query.includes("mutation AddLotToCart")) {
          const sku = body.variables?.sku as string;
          return graphqlOk({ addSimpleProductsToCart: { cart: rawCart([cartLine({ uid: sku, product: { sku, name: sku } })]) } });
        }
        throw new Error(`unexpected query: ${body.query}`);
      } finally {
        inFlight--;
      }
    }), { config: loggedInConfig(), maxConcurrent: 10 });

    const [a, b] = await Promise.all([
      addToCart(client, barolo2017.sku, "LOT-CHEAP"),
      addToCart(client, barolo2017.sku, "LOT-EXPENSIVE"),
    ]);

    assert.equal(maxObserved, 1, "cart operations must never run concurrently on one client");
    assert.equal(a.added_sku, "LOT-CHEAP");
    assert.equal(b.added_sku, "LOT-EXPENSIVE");
  });
});

describe("removeFromCart", () => {
  it("removes a line and reports it gone", async () => {
    const client = makeClient(withLogin((body) => {
      if (body.query.includes("query GetCartId")) return graphqlOk({ customerCart: { id: "cart-1" } });
      if (body.query.includes("mutation RemoveCartItem")) {
        assert.equal(body.variables?.cartItemUid, "u1");
        return graphqlOk({ removeItemFromCart: { cart: rawCart([]) } });
      }
      throw new Error(`unexpected query: ${body.query}`);
    }), { config: loggedInConfig() });

    const result = await removeFromCart(client, "u1");
    assert.equal(result.still_in_cart, false);
    assert.equal(result.removed_uid, "u1");
    assert.equal(result.lines.length, 0);
  });

  it("surfaces a timeout during the mutation as an ambiguous-outcome error", async () => {
    const client = makeClient(
      withLogin((body) => {
        if (body.query.includes("query GetCartId")) return graphqlOk({ customerCart: { id: "cart-1" } });
        if (body.query.includes("mutation RemoveCartItem")) return new Promise(() => {}); // never resolves -> timeout
        throw new Error(`unexpected query: ${body.query}`);
      }),
      { config: loggedInConfig(), timeoutMs: 30 },
    );

    await assert.rejects(() => removeFromCart(client, "u1"), UwbAmbiguousMutationError);
  });
});
