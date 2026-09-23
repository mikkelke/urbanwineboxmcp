import { CART_URL } from "../config.js";
import { decodeHtmlEntities } from "../shape.js";
import type { ApiClient } from "./client.js";
import { UwbNotFoundError } from "./errors.js";

const ORDER_FIELDS = `
  number
  order_date
  status
  total { grand_total { value currency } }
  items {
    product_sku
    product_name
    quantity_ordered
    product_sale_price { value currency }
  }
`;

const GET_ORDERS_QUERY = `
  query GetOrders($pageSize: Int, $currentPage: Int) {
    customer {
      orders(pageSize: $pageSize, currentPage: $currentPage, sort: { sort_field: CREATED_AT, sort_direction: DESC }) {
        total_count
        page_info { current_page page_size total_pages }
        items { ${ORDER_FIELDS} }
      }
    }
  }
`;

const GET_ORDER_BY_NUMBER_QUERY = `
  query GetOrderByNumber($number: String!) {
    customer {
      orders(filter: { number: { eq: $number } }, pageSize: 1, currentPage: 1) {
        items { ${ORDER_FIELDS} }
      }
    }
  }
`;

const GET_WISHLIST_QUERY = `
  query GetWishlist {
    customer {
      wishlists(pageSize: 1, currentPage: 1) {
        id
        items_count
        items_v2(pageSize: 50) {
          items {
            id
            quantity
            added_at
            description
            product {
              sku
              name
              price_range { minimum_price { final_price { value currency } } }
            }
          }
        }
      }
    }
  }
`;

/** Shared with cart.ts so add/remove mutations return the same shape as get_cart. */
export const CART_FIELDS = `
  id
  total_quantity
  prices { grand_total { value currency } }
  itemsV2(pageSize: 50) {
    items {
      uid
      quantity
      errors { message }
      product { sku name }
      prices {
        price { value currency }
        row_total { value currency }
      }
    }
  }
`;

export const GET_CART_QUERY = `
  query GetCart {
    customerCart { ${CART_FIELDS} }
  }
`;

interface RawMoney {
  value: number;
  currency: string;
}

interface RawOrderLine {
  product_sku: string;
  product_name: string;
  quantity_ordered: number;
  product_sale_price?: RawMoney;
}

interface RawOrder {
  number: string;
  order_date: string;
  status: string;
  total: { grand_total: RawMoney };
  items: RawOrderLine[];
}

interface RawWishlistItem {
  id: string;
  quantity: number;
  added_at?: string;
  description?: string;
  product: { sku: string; name: string; price_range: { minimum_price: { final_price: RawMoney } } };
}

interface RawWishlist {
  id: string;
  items_count: number;
  items_v2: { items: RawWishlistItem[] };
}

export interface RawCartItem {
  uid: string;
  quantity: number;
  errors: { message: string }[];
  product: { sku: string; name: string };
  prices?: { price: RawMoney; row_total: RawMoney };
}

export interface RawCart {
  id: string;
  total_quantity: number;
  prices?: { grand_total: RawMoney };
  itemsV2: { items: RawCartItem[] };
}

export interface OrderLineItem {
  sku: string;
  name: string;
  quantity: number;
  price?: number;
  currency?: string;
}

export interface OrderSummary {
  number: string;
  order_date: string;
  status: string;
  total?: number;
  currency?: string;
  item_count: number;
}

export interface OrderDetail extends OrderSummary {
  items: OrderLineItem[];
}

export interface GetOrdersResult {
  orders: OrderSummary[];
  total_count: number;
  page: number;
  page_size: number;
}

export interface WishlistItem {
  id: string;
  sku: string;
  name: string;
  quantity: number;
  price?: number;
  currency?: string;
  added_at?: string;
  note?: string;
}

export interface WishlistResult {
  items: WishlistItem[];
  items_count: number;
}

export interface CartLine {
  uid: string;
  sku: string;
  name: string;
  quantity: number;
  price?: number;
  row_total?: number;
  currency?: string;
  errors: string[];
}

export interface CartState {
  id: string;
  total_quantity: number;
  grand_total?: number;
  currency?: string;
  lines: CartLine[];
  cart_url: string;
  note: string;
}

function toOrderSummary(raw: RawOrder): OrderSummary {
  return {
    number: raw.number,
    order_date: raw.order_date,
    status: raw.status,
    total: raw.total?.grand_total?.value,
    currency: raw.total?.grand_total?.currency,
    item_count: raw.items?.length ?? 0,
  };
}

function toOrderDetail(raw: RawOrder): OrderDetail {
  return {
    ...toOrderSummary(raw),
    items: raw.items.map((line) => ({
      sku: line.product_sku,
      name: decodeHtmlEntities(line.product_name),
      quantity: line.quantity_ordered,
      price: line.product_sale_price?.value,
      currency: line.product_sale_price?.currency,
    })),
  };
}

/** List the account's past orders, newest first. Requires login. */
export async function getOrders(client: ApiClient, page: number, pageSize: number): Promise<GetOrdersResult> {
  const data = await client.customerQuery<{
    customer: {
      orders: {
        total_count: number;
        page_info: { current_page: number; page_size: number };
        items: RawOrder[];
      };
    };
  }>(GET_ORDERS_QUERY, { pageSize, currentPage: page });

  return {
    orders: data.customer.orders.items.map(toOrderSummary),
    total_count: data.customer.orders.total_count,
    page: data.customer.orders.page_info.current_page,
    page_size: data.customer.orders.page_info.page_size,
  };
}

/** Full line items for one past order by its human order number. Requires login. */
export async function getOrderDetails(client: ApiClient, orderNumber: string): Promise<OrderDetail> {
  const data = await client.customerQuery<{ customer: { orders: { items: RawOrder[] } } }>(
    GET_ORDER_BY_NUMBER_QUERY,
    { number: orderNumber },
  );
  const raw = data.customer.orders.items[0];
  if (!raw) throw new UwbNotFoundError(`No order found with number "${orderNumber}".`);
  return toOrderDetail(raw);
}

/** The account's wishlist (first/only one). Requires login. */
export async function getWishlist(client: ApiClient): Promise<WishlistResult> {
  const data = await client.customerQuery<{ customer: { wishlists: RawWishlist[] } }>(GET_WISHLIST_QUERY);
  const wishlist = data.customer.wishlists[0];
  if (!wishlist) return { items: [], items_count: 0 };

  return {
    items: wishlist.items_v2.items.map((item) => ({
      id: item.id,
      sku: item.product.sku,
      name: decodeHtmlEntities(item.product.name),
      quantity: item.quantity,
      price: item.product.price_range?.minimum_price?.final_price?.value,
      currency: item.product.price_range?.minimum_price?.final_price?.currency,
      added_at: item.added_at,
      note: item.description || undefined,
    })),
    items_count: wishlist.items_count,
  };
}

/** Shape a raw Cart response into the tool's output. Shared with cart.ts's mutations. */
export function toCartState(raw: RawCart): CartState {
  return {
    id: raw.id,
    total_quantity: raw.total_quantity,
    grand_total: raw.prices?.grand_total?.value,
    currency: raw.prices?.grand_total?.currency,
    lines: raw.itemsV2.items.map((item) => ({
      uid: item.uid,
      sku: item.product.sku,
      name: decodeHtmlEntities(item.product.name),
      quantity: item.quantity,
      price: item.prices?.price?.value,
      row_total: item.prices?.row_total?.value,
      currency: item.prices?.price?.currency,
      errors: item.errors.map((e) => e.message),
    })),
    cart_url: CART_URL,
    note: "No checkout tools here — open cart_url in a browser to pay.",
  };
}

/**
 * The current cart. Requires login. `customerCart` creates an empty cart on first
 * use if the account doesn't have one yet — harmless, but worth knowing before
 * calling this speculatively.
 */
export async function getCart(client: ApiClient): Promise<CartState> {
  const data = await client.customerQuery<{ customerCart: RawCart }>(GET_CART_QUERY);
  return toCartState(data.customerCart);
}
