import type { RawCart, RawCartItem } from "../../src/api/customer.js";

export function cartLine(overrides: Partial<RawCartItem> = {}): RawCartItem {
  return {
    uid: "cart-item-1",
    quantity: 1,
    errors: [],
    product: { sku: "LOT-CHEAP", name: "Barolo 2017" },
    prices: {
      price: { value: 1500, currency: "DKK" },
      row_total: { value: 1500, currency: "DKK" },
    },
    ...overrides,
  };
}

export function rawCart(items: RawCartItem[] = [], overrides: Partial<RawCart> = {}): RawCart {
  return {
    id: "masked-cart-id",
    total_quantity: items.reduce((sum, i) => sum + i.quantity, 0),
    prices: { grand_total: { value: items.reduce((sum, i) => sum + (i.prices?.row_total.value ?? 0), 0), currency: "DKK" } },
    itemsV2: { items },
    ...overrides,
  };
}
