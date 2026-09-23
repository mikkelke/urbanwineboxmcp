import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { barolo2017 } from "./fixtures/products.js";
import { graphqlOk, loggedInConfig, makeClient, testConfig } from "./testUtils.js";

const EXPECTED_ALWAYS_ON = [
  "search_wines",
  "get_wine",
  "list_categories",
  "get_orders",
  "get_order_details",
  "get_wishlist",
  "get_cart",
];

async function connectedClient(apiClient: ReturnType<typeof makeClient>, config: ReturnType<typeof testConfig>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpServer = createServer({ client: apiClient, config });
  const mcpClient = new Client({ name: "test-client", version: "0" });
  await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);
  return mcpClient;
}

describe("tool registration gating", () => {
  it("lists public + customer-read tools but not cart writes when unconfigured", async () => {
    const apiClient = makeClient(() => {
      throw new Error("no requests expected");
    }, { config: testConfig() });
    const client = await connectedClient(apiClient, testConfig());

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const expected of EXPECTED_ALWAYS_ON) assert.ok(names.includes(expected), `missing ${expected}`);
    assert.ok(!names.includes("add_to_cart"), "add_to_cart must not be listed without cart writes enabled");
    assert.ok(!names.includes("remove_from_cart"), "remove_from_cart must not be listed without cart writes enabled");

    await client.close();
  });

  it("still lists customer-read tools with credentials but writes disabled", async () => {
    const apiClient = makeClient(() => {
      throw new Error("no requests expected");
    }, { config: loggedInConfig() });
    const client = await connectedClient(apiClient, loggedInConfig());

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("get_cart"));
    assert.ok(!names.includes("add_to_cart"));

    await client.close();
  });

  it("adds add_to_cart/remove_from_cart once cart writes are enabled with credentials", async () => {
    const apiClient = makeClient(() => {
      throw new Error("no requests expected");
    }, { config: loggedInConfig({ cartWritesEnabled: true }) });
    const client = await connectedClient(apiClient, loggedInConfig({ cartWritesEnabled: true }));

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of [...EXPECTED_ALWAYS_ON, "add_to_cart", "remove_from_cart"]) {
      assert.ok(names.includes(expected), `missing ${expected}`);
    }

    await client.close();
  });

  it("does not register cart writes with cartWritesEnabled but no credentials", async () => {
    const apiClient = makeClient(() => {
      throw new Error("no requests expected");
    }, { config: testConfig({ cartWritesEnabled: true }) });
    const client = await connectedClient(apiClient, testConfig({ cartWritesEnabled: true }));

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(!names.includes("add_to_cart"));
    assert.ok(!names.includes("remove_from_cart"));

    await client.close();
  });
});

describe("search_wines over the MCP protocol", () => {
  it("returns compact JSON results for a text query", async () => {
    const apiClient = makeClient((body) => {
      if (body.query.includes("query SearchWines")) {
        return graphqlOk({
          products: {
            total_count: 1,
            page_info: { current_page: 1, page_size: 3, total_pages: 1 },
            items: [barolo2017],
          },
        });
      }
      throw new Error(`unexpected query: ${body.query}`);
    }, { config: testConfig() });
    const client = await connectedClient(apiClient, testConfig());

    const result = await client.callTool({ name: "search_wines", arguments: { query: "barolo", page_size: 3 } });
    assert.equal(result.isError, undefined);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    const parsed = JSON.parse(text);
    assert.equal(parsed.items[0].sku, barolo2017.sku);

    await client.close();
  });
});
