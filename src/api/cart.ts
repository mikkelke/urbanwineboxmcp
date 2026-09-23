import { fetchProductBySku } from "./catalog.js";
import type { ApiClient } from "./client.js";
import { CART_FIELDS, toCartState, type CartState, type RawCart } from "./customer.js";
import { UwbAmbiguousMutationError, UwbNetworkError, UwbNotFoundError, UwbValidationError } from "./errors.js";

const GET_CART_ID_QUERY = `
  query GetCartId {
    customerCart { id }
  }
`;

const ADD_LOT_MUTATION = `
  mutation AddLotToCart($cartId: String!, $sku: String!) {
    addSimpleProductsToCart(
      input: { cart_id: $cartId, cart_items: [{ data: { sku: $sku, quantity: 1 } }] }
    ) {
      cart { ${CART_FIELDS} }
    }
  }
`;

const REMOVE_ITEM_MUTATION = `
  mutation RemoveCartItem($cartId: String!, $cartItemUid: ID!) {
    removeItemFromCart(input: { cart_id: $cartId, cart_item_uid: $cartItemUid }) {
      cart { ${CART_FIELDS} }
    }
  }
`;

/** A parent (grouped) sku never has a lot to add on its own — this always rejects it, even before the live check. */
const GROUPED_SKU_PATTERN = /_GROUPED$/i;

export interface AddToCartResult extends CartState {
  added_sku: string;
  now_in_cart: boolean;
}

export interface RemoveFromCartResult extends CartState {
  removed_uid: string;
  still_in_cart: boolean;
}

async function getCartId(client: ApiClient): Promise<string> {
  const data = await client.customerQuery<{ customerCart: { id: string } }>(GET_CART_ID_QUERY);
  return data.customerCart.id;
}

/**
 * A network error or timeout after a mutation was sent doesn't tell us whether it
 * landed server-side — resending blindly risks a double-add. Surface it as
 * "unknown outcome" instead of a plain failure, and point at get_cart to check.
 */
function ambiguousOnNetworkFailure(err: unknown, action: string): unknown {
  if (err instanceof UwbNetworkError) {
    return new UwbAmbiguousMutationError(
      `Could not confirm whether "${action}" succeeded — the request failed after being sent (${err.message}). ` +
        "Call get_cart to check the current state before retrying.",
    );
  }
  return err;
}

/**
 * Add exactly one unit of a specific lot to the cart. `lot_sku` must be a current
 * child of `parent_sku` — verified against a fresh fetch of the parent on every
 * call, never assumed from a prior get_wine result, since lots sell out. Quantity
 * is always 1: each lot is a single physical bottle/case, never a repeatable SKU.
 */
export async function addToCart(client: ApiClient, parentSku: string, lotSku: string): Promise<AddToCartResult> {
  if (GROUPED_SKU_PATTERN.test(lotSku)) {
    throw new UwbValidationError(
      `"${lotSku}" looks like a parent wine sku (ends in _GROUPED), not a lot. Pass one of the lot skus from ` +
        "get_wine's lots[], together with the wine's own sku as parent_sku.",
    );
  }

  return client.withCartLock(async () => {
    const parent = await fetchProductBySku(client, parentSku);
    if (!parent) {
      throw new UwbNotFoundError(`No wine found for parent_sku "${parentSku}".`);
    }
    if (parent.__typename !== "GroupedProduct") {
      throw new UwbValidationError(
        `"${parentSku}" is not a grouped wine product (got ${parent.__typename}). add_to_cart needs the ` +
          "parent wine's sku plus one of its lot skus, not a lot sku by itself.",
      );
    }
    const lot = (parent.items ?? []).find((child) => child.product.sku === lotSku);
    if (!lot) {
      throw new UwbValidationError(
        `Lot "${lotSku}" is not currently among the available lots of "${parentSku}" — it may have sold out. ` +
          "Call get_wine again for the current lot list.",
      );
    }
    if (lot.product.__typename !== "SimpleProduct") {
      throw new UwbValidationError(
        `Lot "${lotSku}" has an unexpected type (${lot.product.__typename}); refusing to add it.`,
      );
    }

    const cartId = await getCartId(client);
    let data: { addSimpleProductsToCart: { cart: RawCart } };
    try {
      data = await client.customerMutate<{ addSimpleProductsToCart: { cart: RawCart } }>(ADD_LOT_MUTATION, {
        cartId,
        sku: lotSku,
      });
    } catch (err) {
      throw ambiguousOnNetworkFailure(err, "add_to_cart");
    }

    const cart = toCartState(data.addSimpleProductsToCart.cart);
    return { ...cart, added_sku: lotSku, now_in_cart: cart.lines.some((line) => line.sku === lotSku) };
  });
}

/** Remove one line from the cart by its `cart_item_uid` (from get_cart's lines[]). */
export async function removeFromCart(client: ApiClient, cartItemUid: string): Promise<RemoveFromCartResult> {
  return client.withCartLock(async () => {
    const cartId = await getCartId(client);
    let data: { removeItemFromCart: { cart: RawCart } };
    try {
      data = await client.customerMutate<{ removeItemFromCart: { cart: RawCart } }>(REMOVE_ITEM_MUTATION, {
        cartId,
        cartItemUid,
      });
    } catch (err) {
      throw ambiguousOnNetworkFailure(err, "remove_from_cart");
    }

    const cart = toCartState(data.removeItemFromCart.cart);
    return {
      ...cart,
      removed_uid: cartItemUid,
      still_in_cart: cart.lines.some((line) => line.uid === cartItemUid),
    };
  });
}
