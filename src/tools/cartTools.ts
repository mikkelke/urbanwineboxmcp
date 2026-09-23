import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addToCart, removeFromCart } from "../api/cart.js";
import type { ApiClient } from "../api/client.js";
import { tool } from "./helpers.js";

const addToCartShape = {
  parent_sku: z.string().min(1).describe("The wine's own sku (get_wine's `sku`), not a lot sku."),
  lot_sku: z.string().min(1).describe("One lot's sku, from get_wine's lots[]. Quantity is always 1 — each lot is a single bottle/case."),
};

const removeFromCartShape = {
  cart_item_uid: z.string().min(1).describe("The line's `uid`, from get_cart's lines[]."),
};

/**
 * Write tools: only registered when URBANWINEBOX_ENABLE_CART_WRITES=1 AND
 * credentials are set (see tools/index.ts). Never registered otherwise — not even
 * to fail with an error at call time — so a client without cart-write access can't
 * see them in tools/list.
 */
export function registerCartWriteTools(server: McpServer, client: ApiClient): void {
  server.registerTool(
    "add_to_cart",
    {
      title: "Add a lot to cart",
      description:
        "Add exactly one unit of a specific lot to the cart. The lot must currently belong to parent_sku " +
        "(re-verified live on every call, since lots sell out) and must not itself be a parent/grouped sku. " +
        "Requires login and URBANWINEBOX_ENABLE_CART_WRITES=1.",
      inputSchema: addToCartShape,
    },
    tool("add_to_cart", ({ parent_sku, lot_sku }) => addToCart(client, parent_sku, lot_sku)),
  );

  server.registerTool(
    "remove_from_cart",
    {
      title: "Remove a line from cart",
      description: "Remove one line from the cart. Requires login and URBANWINEBOX_ENABLE_CART_WRITES=1.",
      inputSchema: removeFromCartShape,
    },
    tool("remove_from_cart", ({ cart_item_uid }) => removeFromCart(client, cart_item_uid)),
  );
}
