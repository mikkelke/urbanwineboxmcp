import { MEDIA_BASE_URL } from "./config.js";

/** One attribute entry as returned by `custom_attributesV2.items`. */
export interface RawAttributeItem {
  code: string;
  value?: string;
  selected_options?: { label: string; value: string }[];
}

export interface RawMoney {
  value: number;
  currency: string;
}

export interface RawPriceRange {
  minimum_price: { final_price: RawMoney };
  maximum_price?: { final_price: RawMoney };
}

/** A grouped product's child, as returned by `GroupedProduct.items`. */
export interface RawGroupedChild {
  qty?: number;
  position?: number;
  product: {
    __typename: string;
    sku: string;
    price_range: RawPriceRange;
    custom_attributesV2?: { items: RawAttributeItem[] };
  };
}

/** A product as returned by the `products`/`route` queries (parent, i.e. the wine). */
export interface RawProduct {
  __typename: string;
  uid: string;
  sku: string;
  name: string;
  url_key: string;
  url_suffix: string;
  description?: { html: string };
  price_range: RawPriceRange;
  custom_attributesV2: { items: RawAttributeItem[] };
  items?: RawGroupedChild[];
}

export interface Lot {
  sku: string;
  price: number;
  currency: string;
  condition?: string;
  warehouse?: string;
  warehoused_date?: string;
  bottles_count?: number;
}

export interface WineSummary {
  sku: string;
  name: string;
  url: string;
  price_min: number;
  price_max: number;
  currency: string;
  vintage?: number;
  wine_type?: string;
  country?: string;
  district?: string;
  producer?: string;
  bottle_size?: string;
  condition?: string;
  bottles_count?: number;
  is_box?: boolean;
  /** Count of lots currently listed for this wine. Inferred availability, not live stock. */
  lots_available: number;
  image?: string;
}

export interface WineDetail extends WineSummary {
  description?: string;
  case_type?: string;
  giftbox?: string;
  subregion?: string;
  appelation?: string;
  note?: string;
  /** Lots listed for this wine, cheapest first. */
  lots: Lot[];
}

const HTML_ENTITIES: Record<string, string> = {
  quot: '"',
  apos: "'",
  amp: "&",
  lt: "<",
  gt: ">",
  nbsp: " ",
};

/** Decode the small set of HTML entities the catalog uses in names/descriptions. */
export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const replacement = HTML_ENTITIES[entity.toLowerCase()];
    return replacement ?? match;
  });
}

/** Strip HTML tags from a description, then decode entities. */
export function stripHtml(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

/** Build the public product URL. `url_key` can (rarely) contain spaces/quotes, so it's percent-encoded. */
export function buildProductUrl(urlKey: string, urlSuffix: string): string {
  return `https://urbanwinebox.com/${encodeURIComponent(urlKey)}${urlSuffix}`;
}

export type ImageSize = "265x265" | "1200x1200";

/** Build a media URL from the `main_photo_link` custom attribute (a relative path), or undefined if unset. */
export function buildImageUrl(mainPhotoLink: string | undefined, size: ImageSize = "265x265"): string | undefined {
  if (!mainPhotoLink) return undefined;
  const path = mainPhotoLink.startsWith("/") ? mainPhotoLink : `/${mainPhotoLink}`;
  return `${MEDIA_BASE_URL}/${size}${path}`;
}

/** Flatten `custom_attributesV2.items` into code -> display value (select label, or the raw value). */
export function attributesToMap(items: RawAttributeItem[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    const label = item.selected_options?.[0]?.label;
    if (label !== undefined) map.set(item.code, label);
    else if (item.value !== undefined) map.set(item.code, item.value);
  }
  return map;
}

function parseIntOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

function priceOf(range: RawPriceRange, pick: "minimum_price" | "maximum_price"): RawMoney {
  return (range[pick] ?? range.minimum_price).final_price;
}

function childPrice(child: RawGroupedChild): RawMoney {
  return child.product.price_range.minimum_price.final_price;
}

/** Build a lightweight summary. Price range and lot count come from `items` (children) when present. */
export function toWineSummary(raw: RawProduct): WineSummary {
  const attrs = attributesToMap(raw.custom_attributesV2.items);
  const children = raw.items ?? [];
  const prices =
    children.length > 0
      ? children.map(childPrice)
      : [priceOf(raw.price_range, "minimum_price"), priceOf(raw.price_range, "maximum_price")];
  const currency = prices[0]?.currency ?? priceOf(raw.price_range, "minimum_price").currency;

  return {
    sku: raw.sku,
    name: decodeHtmlEntities(raw.name),
    url: buildProductUrl(raw.url_key, raw.url_suffix),
    price_min: Math.min(...prices.map((p) => p.value)),
    price_max: Math.max(...prices.map((p) => p.value)),
    currency,
    vintage: parseIntOrUndefined(attrs.get("year")),
    wine_type: attrs.get("wine_type"),
    country: attrs.get("country"),
    district: attrs.get("district"),
    producer: attrs.get("producer"),
    bottle_size: attrs.get("bottle_size"),
    condition: attrs.get("photo"),
    bottles_count: parseIntOrUndefined(attrs.get("bottles_count")),
    is_box: attrs.get("is_box") === undefined ? undefined : attrs.get("is_box") !== "0",
    lots_available: children.length,
    image: buildImageUrl(attrs.get("main_photo_link")),
  };
}

function toLot(child: RawGroupedChild): Lot {
  const attrs = attributesToMap(child.product.custom_attributesV2?.items ?? []);
  const price = childPrice(child);
  return {
    sku: child.product.sku,
    price: price.value,
    currency: price.currency,
    condition: attrs.get("photo"),
    warehouse: attrs.get("warehouse_filter"),
    warehoused_date: attrs.get("warehoused_date"),
    bottles_count: parseIntOrUndefined(attrs.get("bottles_count")),
  };
}

/** Build the full detail view, including every lot (sorted cheapest first). */
export function toWineDetail(raw: RawProduct): WineDetail {
  const summary = toWineSummary(raw);
  const attrs = attributesToMap(raw.custom_attributesV2.items);
  const lots = (raw.items ?? []).map(toLot).sort((a, b) => a.price - b.price);

  return {
    ...summary,
    description: raw.description?.html ? stripHtml(raw.description.html) : undefined,
    case_type: attrs.get("case_type"),
    giftbox: attrs.get("giftbox"),
    subregion: attrs.get("subregion"),
    appelation: attrs.get("appelation"),
    note: attrs.get("note"),
    lots,
  };
}
