import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api/client.js";
import { getWineBySku, getWineByUrl, getWineByUrlKey, listCategories, searchWines } from "../api/catalog.js";
import { UwbValidationError } from "../api/errors.js";
import { tool } from "./helpers.js";

const searchWinesShape = {
  query: z.string().min(1).optional().describe("Free-text search, e.g. producer or wine name."),
  wine_type: z.string().optional().describe("Label, e.g. 'Red wine'. Matched case-insensitively against the real option list."),
  country: z.string().optional().describe("Label, e.g. 'Italy'."),
  district: z.string().optional().describe("Label, e.g. 'Piemonte'."),
  producer: z
    .string()
    .optional()
    .describe(
      "Producer name. Matched approximately (added to the free-text search, not resolved to an exact id — " +
        "the producer list has 8000+ entries).",
    ),
  bottle_size: z.string().optional().describe("Label, e.g. '750 ml (Standard)'."),
  condition: z.string().optional().describe("Bottle condition label, e.g. 'Condition A'."),
  vintage: z.number().int().min(1900).max(2100).optional().describe("4-digit vintage year."),
  min_price: z.number().min(0).optional().describe("Minimum price (store currency, DKK)."),
  max_price: z.number().min(0).optional().describe("Maximum price (store currency, DKK)."),
  category_uid: z.string().optional().describe("A category uid from list_categories."),
  in_stock_only: z.boolean().default(true).describe("Drop wines with no lots currently listed."),
  sort: z.enum(["relevance", "price", "name", "position", "updated_at"]).default("relevance"),
  sort_direction: z.enum(["ASC", "DESC"]).default("ASC"),
  page: z.number().int().min(1).default(1),
  page_size: z.number().int().min(1).max(50).default(20),
};

const getWineShape = {
  sku: z.string().min(1).optional().describe("The wine's own (parent, grouped) sku — not a lot sku."),
  url_key: z.string().min(1).optional().describe("The product's url_key, from a search result."),
  url: z.string().min(1).optional().describe("The product's full URL (or bare path), from a search result."),
};

const listCategoriesShape = {};

export function registerCatalogTools(server: McpServer, client: ApiClient): void {
  server.registerTool(
    "search_wines",
    {
      title: "Search wines",
      description:
        "Search the urbanwinebox.com catalog. Each result is one wine (a 'GroupedProduct') that may have " +
        "several individually priced lots (single bottles or cases). Returns compact summaries with a price " +
        "range across lots; use get_wine for the full per-lot breakdown. Works without login.",
      inputSchema: searchWinesShape,
    },
    tool("search_wines", (args) => searchWines(client, args)),
  );

  server.registerTool(
    "get_wine",
    {
      title: "Get wine detail",
      description:
        "Full detail for one wine, including every currently listed lot (sku, price, condition, warehouse) " +
        "sorted cheapest first. Pass exactly one of sku, url_key or url (typically from a search_wines result). " +
        "Works without login.",
      inputSchema: getWineShape,
    },
    tool("get_wine", async ({ sku, url_key, url }: { sku?: string; url_key?: string; url?: string }) => {
      const given = [sku, url_key, url].filter((v) => v !== undefined);
      if (given.length !== 1) {
        throw new UwbValidationError("Pass exactly one of sku, url_key or url.");
      }
      if (sku) return getWineBySku(client, sku);
      if (url_key) return getWineByUrlKey(client, url_key);
      return getWineByUrl(client, url as string);
    }),
  );

  server.registerTool(
    "list_categories",
    {
      title: "List categories and facets",
      description:
        "The real category tree, plus the small facet option lists (wine_type, country, bottle_size) usable " +
        "as search_wines filters — kept separate from the category tree. Works without login.",
      inputSchema: listCategoriesShape,
    },
    tool("list_categories", () => listCategories(client)),
  );
}
