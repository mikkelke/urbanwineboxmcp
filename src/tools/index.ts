import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api/client.js";
import type { Config } from "../config.js";
import { registerCartWriteTools } from "./cartTools.js";
import { registerCatalogTools } from "./catalogTools.js";
import { registerCustomerTools } from "./customerTools.js";

export function registerAllTools(server: McpServer, client: ApiClient, config: Config): void {
  registerCatalogTools(server, client);
  registerCustomerTools(server, client);
  // Cart writes are opt-in and credential-gated: never registered otherwise, so
  // they don't even appear in tools/list without both URBANWINEBOX_ENABLE_CART_WRITES=1
  // and credentials.
  if (config.cartWritesEnabled && config.hasCredentials) {
    registerCartWriteTools(server, client);
  }
}
