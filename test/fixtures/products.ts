import type { RawProduct } from "../../src/shape.js";

/** A representative GroupedProduct with two lots, mirroring the live schema. */
export const barolo2017: RawProduct = {
  __typename: "GroupedProduct",
  uid: "MjA3MzU0",
  sku: "a1G2o00000LWvUMEA1_GROUPED",
  name: "Barolo &quot;Brunate&quot; 2017 750 ml (Standard)",
  url_key: 'barolo "brunate" 2017 750 ml (standard)-a1g2o00000lwvumea1',
  url_suffix: ".html",
  description: { html: "<p>A classic Barolo.</p>" },
  price_range: {
    minimum_price: { final_price: { value: 1500, currency: "DKK" } },
    maximum_price: { final_price: { value: 1650, currency: "DKK" } },
  },
  custom_attributesV2: {
    items: [
      { code: "wine_type", selected_options: [{ label: "Red wine", value: "22858" }] },
      { code: "country", selected_options: [{ label: "Italy", value: "22911" }] },
      { code: "producer", selected_options: [{ label: "Bartolo Mascarello", value: "63663" }] },
      { code: "district", selected_options: [{ label: "Piemonte", value: "23078" }] },
      { code: "bottle_size", selected_options: [{ label: "750 ml (Standard)", value: "22869" }] },
      { code: "photo", selected_options: [{ label: "Condition A", value: "81" }] },
      { code: "giftbox", selected_options: [{ label: "No", value: "86" }] },
      { code: "case_type", selected_options: [{ label: "OC", value: "66461" }] },
      { code: "year", value: "2017" },
      { code: "is_box", value: "0" },
      { code: "bottles_count", value: "1" },
      { code: "main_photo_link", value: "/a/b/photo.jpg" },
      { code: "purchase_price", value: "0.000000" },
    ],
  },
  items: [
    {
      qty: 1,
      position: 1,
      product: {
        __typename: "SimpleProduct",
        sku: "LOT-EXPENSIVE",
        price_range: { minimum_price: { final_price: { value: 1650, currency: "DKK" } } },
        custom_attributesV2: {
          items: [
            { code: "photo", selected_options: [{ label: "Condition A", value: "81" }] },
            { code: "warehouse_filter", selected_options: [{ label: "Copenhagen", value: "1" }] },
            { code: "warehoused_date", value: "2023-02-16 16:45:48" },
            { code: "bottles_count", value: "1" },
          ],
        },
      },
    },
    {
      qty: 1,
      position: 2,
      product: {
        __typename: "SimpleProduct",
        sku: "LOT-CHEAP",
        price_range: { minimum_price: { final_price: { value: 1500, currency: "DKK" } } },
        custom_attributesV2: {
          items: [
            { code: "photo", selected_options: [{ label: "Condition B", value: "82" }] },
            { code: "warehouse_filter", selected_options: [{ label: "Aarhus", value: "2" }] },
            { code: "warehoused_date", value: "2022-11-01 10:00:00" },
            { code: "bottles_count", value: "1" },
          ],
        },
      },
    },
  ],
};

/** Same wine with no lots left — used for in_stock_only / sold-out scenarios. */
export const soldOutWine: RawProduct = {
  ...barolo2017,
  sku: "a1SOLDOUT_GROUPED",
  name: "Sold Out Wine 2019 750 ml (Standard)",
  items: [],
};

export const wineTypeOptions = [
  { label: "Red wine", value: "22858" },
  { label: "White wine", value: "22859" },
  { label: "Rose wine", value: "22860" },
];

export const countryOptions = [
  { label: "Italy", value: "22911" },
  { label: "France", value: "22912" },
];
