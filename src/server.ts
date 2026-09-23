import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiClient } from "./api/client.js";
import { loadConfig, type Config } from "./config.js";
import { logger } from "./logger.js";
import { registerAllTools } from "./tools/index.js";

export interface SharedClient {
  client: ApiClient;
  config: Config;
}

/**
 * Build a fully configured MCP server. Transport-agnostic: the caller wires up
 * stdio or HTTP and connects it. Pass `shared` to reuse an existing client/config
 * (e.g. one ApiClient across every HTTP session) instead of reading the environment.
 */
export function createServer(shared?: SharedClient): McpServer {
  let client: ApiClient;
  let config: Config;
  if (shared) {
    ({ client, config } = shared);
  } else {
    config = loadConfig();
    logger.info("starting urbanwineboxmcp", {
      mode: config.hasCredentials ? "login" : "anonymous",
      cartWrites: config.cartWritesEnabled && config.hasCredentials,
    });
    client = new ApiClient(config);
  }

  const server = new McpServer({
    name: "urbanwineboxmcp",
    version: "0.1.0",
  });

  registerAllTools(server, client, config);
  return server;
}
