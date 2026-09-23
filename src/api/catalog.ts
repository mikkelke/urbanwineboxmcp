import type { ApiClient } from "./client.js";
import { UwbNotFoundError, UwbValidationError } from "./errors.js";
import { toWineDetail, toWineSummary, type RawProduct, type WineDetail, type WineSummary } from "../shape.js";

const CUSTOM_ATTRS_FIELDS = `
  custom_attributesV2 {
    items {
      code
      ... on AttributeValue { value }
      ... on AttributeSelectedOptions { selected_options { label value } }
    }
  }
`;

/** Light child selection for search results: enough to compute price range and lot count. */
const SEARCH_ITEM_FIELDS = `
  __typename
  uid
  sku
  name
  url_key
  url_suffix
  price_range {
    minimum_price { final_price { value currency } }
    maximum_price { final_price { value currency } }
  }
  ${CUSTOM_ATTRS_FIELDS}
  ... on GroupedProduct {
    items {
      product {
        sku
        price_range { minimum_price { final_price { value currency } } }
      }
    }
  }
`;

/** Full child selection for a single product: every lot's own attributes. */
const DETAIL_ITEM_FIELDS = `
  __typename
  uid
  sku
  name
  url_key
  url_suffix
  description { html }
  price_range {
    minimum_price { final_price { value currency } }
    maximum_price { final_price { value currency } }
  }
  ${CUSTOM_ATTRS_FIELDS}
  ... on GroupedProduct {
    items {
      qty
      position
      product {
        __typename
        sku
        price_range { minimum_price { final_price { value currency } } }
        ${CUSTOM_ATTRS_FIELDS}
      }
    }
  }
`;

const SEARCH_QUERY = `
  query SearchWines(
    $search: String
    $filter: ProductAttributeFilterInput
    $sort: ProductAttributeSortInput
    $pageSize: Int
    $currentPage: Int
  ) {
    products(search: $search, filter: $filter, sort: $sort, pageSize: $pageSize, currentPage: $currentPage) {
      total_count
      page_info { current_page page_size total_pages }
      items { ${SEARCH_ITEM_FIELDS} }
    }
  }
`;

const PRODUCT_BY_FILTER_QUERY = `
  query ProductByFilter($filter: ProductAttributeFilterInput!) {
    products(filter: $filter, pageSize: 1, currentPage: 1) {
      items { ${DETAIL_ITEM_FIELDS} }
    }
  }
`;

const ROUTE_QUERY = `
  query WineRoute($url: String!) {
    route(url: $url) {
      __typename
      ... on GroupedProduct { ${DETAIL_ITEM_FIELDS} }
    }
  }
`;

const CATEGORIES_QUERY = `
  query WineCategories {
    categories(filters: { ids: { eq: "2" } }) {
      items {
        uid
        name
        url_path
        product_count
        children {
          uid
          name
          url_path
          product_count
          children { uid name url_path product_count }
        }
      }
    }
  }
`;

const ATTRIBUTE_METADATA_QUERY = `
  query AttributeMetadata($attributes: [AttributeInput!]) {
    customAttributeMetadataV2(attributes: $attributes) {
      errors { type message }
      items { code label options { label value } }
    }
  }
`;

interface SearchResponse {
  products: {
    total_count: number;
    page_info: { current_page: number; page_size: number; total_pages: number };
    items: RawProduct[];
  };
}

interface ProductByFilterResponse {
  products: { items: RawProduct[] };
}

interface RouteResponse {
  route: (Partial<RawProduct> & { __typename: string }) | null;
}

interface RawCategory {
  uid: string;
  name: string;
  url_path?: string | null;
  product_count?: number | null;
  children?: RawCategory[] | null;
}

interface CategoriesResponse {
  categories: { items: RawCategory[] };
}

export interface AttributeOption {
  label: string;
  value: string;
}

interface AttributeMetadataResponse {
  customAttributeMetadataV2: {
    errors: { type: string; message: string }[];
    items: { code: string; options: AttributeOption[] }[];
  };
}

export interface CategoryNode {
  uid: string;
  name: string;
  url_path?: string;
  product_count?: number;
  children: CategoryNode[];
}

export interface CategoriesResult {
  categories: CategoryNode[];
  facets: {
    wine_type: AttributeOption[];
    country: AttributeOption[];
    bottle_size: AttributeOption[];
  };
}

export type SortField = "relevance" | "price" | "name" | "position" | "updated_at";
export type SortDirection = "ASC" | "DESC";

export interface SearchWinesParams {
  query?: string;
  wine_type?: string;
  country?: string;
  district?: string;
  producer?: string;
  bottle_size?: string;
  condition?: string;
  vintage?: number;
  min_price?: number;
  max_price?: number;
  category_uid?: string;
  in_stock_only: boolean;
  sort: SortField;
  sort_direction: SortDirection;
  page: number;
  page_size: number;
}

export interface SearchWinesResult {
  items: WineSummary[];
  total_count: number;
  page: number;
  page_size: number;
  total_pages: number;
  /** True when a `producer` filter was applied — matched via free text, not an exact id. */
  approximate: boolean;
  notes: string[];
}

/** Attribute codes small enough to fetch in full and resolve a label to an exact option id. */
export const RESOLVABLE_ATTRIBUTES = new Set(["wine_type", "country", "district", "bottle_size", "photo"]);

const OPTIONS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Per-client 24h cache of small attribute option lists (never producer/wine — see catalog docs). */
const optionsCacheByClient = new WeakMap<ApiClient, Map<string, { options: AttributeOption[]; expiresAt: number }>>();

function cacheFor(client: ApiClient): Map<string, { options: AttributeOption[]; expiresAt: number }> {
  let cache = optionsCacheByClient.get(client);
  if (!cache) {
    cache = new Map();
    optionsCacheByClient.set(client, cache);
  }
  return cache;
}

/** Fetch (and cache for 24h) the full option list for one of RESOLVABLE_ATTRIBUTES. */
export async function getAttributeOptions(client: ApiClient, code: string): Promise<AttributeOption[]> {
  const cache = cacheFor(client);
  const hit = cache.get(code);
  if (hit && hit.expiresAt > Date.now()) return hit.options;

  const data = await client.publicQuery<AttributeMetadataResponse>(ATTRIBUTE_METADATA_QUERY, {
    attributes: [{ attribute_code: code, entity_type: "catalog_product" }],
  });
  const options = data.customAttributeMetadataV2.items[0]?.options ?? [];
  cache.set(code, { options, expiresAt: Date.now() + OPTIONS_CACHE_TTL_MS });
  return options;
}

/** Resolve a human label to its exact option id for one of RESOLVABLE_ATTRIBUTES. */
async function resolveLabel(client: ApiClient, code: string, label: string): Promise<string> {
  const options = await getAttributeOptions(client, code);
  const norm = label.trim().toLowerCase();
  const exact = options.find((o) => o.label.toLowerCase() === norm);
  if (exact) return exact.value;

  const partial = options.filter((o) => o.label.toLowerCase().includes(norm));
  if (partial.length === 1) return partial[0].value;

  const suggestions = partial.slice(0, 5).map((o) => o.label);
  throw new UwbValidationError(
    `No exact match for "${label}" in ${code}.` +
      (suggestions.length > 0
        ? ` Close matches: ${suggestions.join(", ")}.`
        : " Call list_categories to see valid values for wine_type/country/bottle_size."),
  );
}

interface ResolvedFilters {
  wine_type?: string;
  country?: string;
  district?: string;
  bottle_size?: string;
  condition?: string;
}

async function resolveFilterLabels(client: ApiClient, params: SearchWinesParams): Promise<ResolvedFilters> {
  const entries: [keyof ResolvedFilters, string, string | undefined][] = [
    ["wine_type", "wine_type", params.wine_type],
    ["country", "country", params.country],
    ["district", "district", params.district],
    ["bottle_size", "bottle_size", params.bottle_size],
    ["condition", "photo", params.condition],
  ];
  const resolved: ResolvedFilters = {};
  await Promise.all(
    entries.map(async ([key, code, label]) => {
      if (label === undefined) return;
      resolved[key] = await resolveLabel(client, code, label);
    }),
  );
  return resolved;
}

function buildFilter(params: SearchWinesParams, resolved: ResolvedFilters): Record<string, unknown> | undefined {
  const filter: Record<string, unknown> = {};
  if (resolved.wine_type) filter.wine_type = { eq: resolved.wine_type };
  if (resolved.country) filter.country = { eq: resolved.country };
  if (resolved.district) filter.district = { eq: resolved.district };
  if (resolved.bottle_size) filter.bottle_size = { eq: resolved.bottle_size };
  if (resolved.condition) filter.photo = { eq: resolved.condition };
  if (params.category_uid) filter.category_uid = { eq: params.category_uid };
  if (params.vintage !== undefined) filter.year = { match: String(params.vintage) };
  if (params.min_price !== undefined || params.max_price !== undefined) {
    filter.price = {
      from: params.min_price !== undefined ? String(params.min_price) : undefined,
      to: params.max_price !== undefined ? String(params.max_price) : undefined,
    };
  }
  return Object.keys(filter).length > 0 ? filter : undefined;
}

/**
 * Search the catalog. Always anonymous. `producer` is never resolved to an exact id
 * (the option list has 8000+ entries) — it's folded into the free-text `search` term
 * instead, and the result carries a note that the match is approximate. `vintage`
 * and `in_stock_only` are applied server-side and then re-checked client-side (the
 * year filter can fuzzy-match; there is no stock field, only lot presence), so a
 * page can come back with fewer than `page_size` items — noted when it happens.
 */
export async function searchWines(client: ApiClient, params: SearchWinesParams): Promise<SearchWinesResult> {
  const notes: string[] = [];
  const resolved = await resolveFilterLabels(client, params);
  const filter = buildFilter(params, resolved);

  let search = params.query?.trim() || undefined;
  if (params.producer) {
    search = [search, params.producer].filter(Boolean).join(" ");
    notes.push(
      `producer "${params.producer}" was added to the free-text search rather than matched to an exact ` +
        "producer id (the producer list is too large to fetch); results are approximate.",
    );
  }

  const data = await client.publicQuery<SearchResponse>(SEARCH_QUERY, {
    search,
    filter,
    sort: { [params.sort]: params.sort_direction },
    pageSize: params.page_size,
    currentPage: params.page,
  });

  let items = data.products.items.map(toWineSummary);

  if (params.vintage !== undefined) {
    const before = items.length;
    items = items.filter((w) => w.vintage === params.vintage);
    if (items.length !== before) {
      notes.push(
        "Some results were dropped after re-checking the vintage client-side (the server-side year filter " +
          "can fuzzy-match); this page may contain fewer than page_size results.",
      );
    }
  }
  if (params.in_stock_only) {
    const before = items.length;
    items = items.filter((w) => w.lots_available > 0);
    if (items.length !== before) {
      notes.push(
        "Some results were dropped because they currently have no lots listed; this page may contain fewer " +
          "than page_size results.",
      );
    }
  }

  return {
    items,
    total_count: data.products.total_count,
    page: data.products.page_info.current_page,
    page_size: data.products.page_info.page_size,
    total_pages: data.products.page_info.total_pages,
    approximate: !!params.producer,
    notes,
  };
}

/** Fetch one product's raw detail fields by an exact sku, or undefined if not found. */
export async function fetchProductBySku(client: ApiClient, sku: string): Promise<RawProduct | undefined> {
  const data = await client.publicQuery<ProductByFilterResponse>(PRODUCT_BY_FILTER_QUERY, {
    filter: { sku: { eq: sku } },
  });
  return data.products.items[0];
}

async function fetchProductByUrlKey(client: ApiClient, urlKey: string): Promise<RawProduct | undefined> {
  const data = await client.publicQuery<ProductByFilterResponse>(PRODUCT_BY_FILTER_QUERY, {
    filter: { url_key: { eq: urlKey } },
  });
  return data.products.items[0];
}

function extractRoutePath(url: string): string {
  let path = url.trim();
  path = path.replace(/^https?:\/\/[^/]+\//i, "");
  path = path.replace(/^\/+/, "");
  if (!path.endsWith(".html")) path += ".html";
  return path;
}

function assertGroupedProduct(
  raw: (Partial<RawProduct> & { __typename?: string }) | null | undefined,
  identifier: string,
): asserts raw is RawProduct {
  if (!raw) {
    throw new UwbNotFoundError(
      `No wine found for "${identifier}". If this is a lot sku (one bottle/case), pass the parent wine's ` +
        "sku instead — lots aren't searchable directly, only through their parent's get_wine result.",
    );
  }
  if (raw.__typename !== "GroupedProduct") {
    throw new UwbValidationError(`"${identifier}" is not a grouped wine product (got ${raw.__typename}).`);
  }
}

/** Get one wine's full detail by its parent (grouped) sku. */
export async function getWineBySku(client: ApiClient, sku: string): Promise<WineDetail> {
  const raw = await fetchProductBySku(client, sku);
  assertGroupedProduct(raw, sku);
  return toWineDetail(raw);
}

/** Get one wine's full detail by its url_key. */
export async function getWineByUrlKey(client: ApiClient, urlKey: string): Promise<WineDetail> {
  const raw = await fetchProductByUrlKey(client, urlKey);
  assertGroupedProduct(raw, urlKey);
  return toWineDetail(raw);
}

/** Get one wine's full detail by its full product URL (or bare url_key/path). */
export async function getWineByUrl(client: ApiClient, url: string): Promise<WineDetail> {
  const path = extractRoutePath(url);
  const data = await client.publicQuery<RouteResponse>(ROUTE_QUERY, { url: path });
  const raw = data.route;
  assertGroupedProduct(raw, url);
  return toWineDetail(raw);
}

function toCategoryNode(raw: RawCategory): CategoryNode {
  return {
    uid: raw.uid,
    name: raw.name,
    url_path: raw.url_path ?? undefined,
    product_count: raw.product_count ?? undefined,
    children: (raw.children ?? []).map(toCategoryNode),
  };
}

/** Real category tree plus the small facet option lists (wine_type/country/bottle_size), kept separate. */
export async function listCategories(client: ApiClient): Promise<CategoriesResult> {
  const [categoriesData, wineType, country, bottleSize] = await Promise.all([
    client.publicQuery<CategoriesResponse>(CATEGORIES_QUERY),
    getAttributeOptions(client, "wine_type"),
    getAttributeOptions(client, "country"),
    getAttributeOptions(client, "bottle_size"),
  ]);

  return {
    categories: categoriesData.categories.items.map(toCategoryNode),
    facets: { wine_type: wineType, country, bottle_size: bottleSize },
  };
}
