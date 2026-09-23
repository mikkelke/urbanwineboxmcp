import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api/client.js";
import { getCart, getOrderDetails, getOrders, getWishlist } from "../api/customer.js";
import { tool } from "./helpers.js";

const getOrdersShape = {
  page: z.number().int().min(1).default(1),
  page_size: z.number().int().min(1).max(50).default(10),
};

const getOrderDetailsShape = {
  order_number: z.string().min(1).describe("The order's human-facing number, from get_orders."),
};

const getWishlistShape = {};

const getCartShape = {};

/**
 * Always-registered, credential-gated tools: they appear in tools/list regardless
 * of configuration, but throw a clear "login required" error at call time when
 * URBANWINEBOX_EMAIL/URBANWINEBOX_PASSWORD are unset (see Session.requireLogin).
 */
export function registerCustomerTools(server: McpServer, client: ApiClient): void {
  server.registerTool(
    "get_orders",
    {
      title: "Get past orders",
      description: "List the account's past orders, newest first, with paging. Requires login.",
      inputSchema: getOrdersShape,
    },
    tool("get_orders", ({ page, page_size }) => getOrders(client, page, page_size)),
  );

  server.registerTool(
    "get_order_details",
    {
      title: "Get order details",
      description: "Full line items for one past order by its order number (from get_orders). Requires login.",
      inputSchema: getOrderDetailsShape,
    },
    tool("get_order_details", ({ order_number }) => getOrderDetails(client, order_number)),
  );

  server.registerTool(
    "get_wishlist",
    {
      title: "Get wishlist",
      description: "The account's wishlist items. Requires login.",
      inputSchema: getWishlistShape,
    },
    tool("get_wishlist", () => getWishlist(client)),
  );

  server.registerTool(
    "get_cart",
    {
      title: "Get cart",
      description:
        "The current cart: lines (sku, name, quantity, price) and totals, plus cart_url to pay in a browser " +
        "— there is no checkout tool. Requires login. Note: this creates an empty cart on the account if it " +
        "doesn't have one yet (a harmless side effect of how the store's API resolves 'the current cart').",
      inputSchema: getCartShape,
    },
    tool("get_cart", () => getCart(client)),
  );
}
