import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attributesToMap,
  buildImageUrl,
  buildProductUrl,
  decodeHtmlEntities,
  stripHtml,
  toWineDetail,
  toWineSummary,
} from "../src/shape.js";
import { barolo2017, soldOutWine } from "./fixtures/products.js";

describe("decodeHtmlEntities", () => {
  it("decodes named and numeric entities", () => {
    assert.equal(decodeHtmlEntities("Barolo &quot;Brunate&quot;"), 'Barolo "Brunate"');
    assert.equal(decodeHtmlEntities("Fish &amp; Chips"), "Fish & Chips");
    assert.equal(decodeHtmlEntities("&#39;s &#x27;s"), "'s 's");
  });

  it("leaves plain text and unknown entities untouched", () => {
    assert.equal(decodeHtmlEntities("Chianti Classico 2019"), "Chianti Classico 2019");
    assert.equal(decodeHtmlEntities("&notareal;"), "&notareal;");
  });
});

describe("stripHtml", () => {
  it("removes tags and decodes entities", () => {
    assert.equal(stripHtml("<p>A &amp; B</p>"), "A & B");
  });
});

describe("buildProductUrl", () => {
  it("percent-encodes url_keys with spaces or quotes", () => {
    const url = buildProductUrl('barolo "brunate" 2017-a1', ".html");
    assert.equal(url, "https://urbanwinebox.com/barolo%20%22brunate%22%202017-a1.html");
  });

  it("passes clean url_keys through readably", () => {
    const url = buildProductUrl("barolo-2017-750-ml-standard-a1g2o00000lwvumea1", ".html");
    assert.equal(url, "https://urbanwinebox.com/barolo-2017-750-ml-standard-a1g2o00000lwvumea1.html");
  });
});

describe("buildImageUrl", () => {
  it("prefixes the media host and size", () => {
    assert.equal(buildImageUrl("/a/b/photo.jpg"), "https://media.urbanwinebox.com/265x265/a/b/photo.jpg");
    assert.equal(buildImageUrl("/a/b/photo.jpg", "1200x1200"), "https://media.urbanwinebox.com/1200x1200/a/b/photo.jpg");
  });

  it("returns undefined when unset", () => {
    assert.equal(buildImageUrl(undefined), undefined);
  });
});

describe("attributesToMap", () => {
  it("prefers the selected option's label over a raw value", () => {
    const map = attributesToMap([
      { code: "wine_type", selected_options: [{ label: "Red wine", value: "1" }] },
      { code: "year", value: "2017" },
    ]);
    assert.equal(map.get("wine_type"), "Red wine");
    assert.equal(map.get("year"), "2017");
    assert.equal(map.get("missing"), undefined);
  });
});

describe("toWineSummary", () => {
  it("maps price range and lot count from the children, and decodes the name", () => {
    const summary = toWineSummary(barolo2017);
    assert.equal(summary.name, 'Barolo "Brunate" 2017 750 ml (Standard)');
    assert.equal(summary.price_min, 1500);
    assert.equal(summary.price_max, 1650);
    assert.equal(summary.currency, "DKK");
    assert.equal(summary.lots_available, 2);
    assert.equal(summary.vintage, 2017);
    assert.equal(summary.wine_type, "Red wine");
    assert.equal(summary.condition, "Condition A");
    assert.equal(summary.image, "https://media.urbanwinebox.com/265x265/a/b/photo.jpg");
    assert.equal(summary.bottles_count, 1);
    assert.equal(summary.is_box, false);
  });

  it("falls back to the parent's own price range and reports zero lots when sold out", () => {
    const summary = toWineSummary(soldOutWine);
    assert.equal(summary.lots_available, 0);
    assert.equal(summary.price_min, 1500);
    assert.equal(summary.price_max, 1650);
  });
});

describe("toWineDetail", () => {
  it("sorts lots cheapest-first and exposes per-lot fields", () => {
    const detail = toWineDetail(barolo2017);
    assert.equal(detail.lots.length, 2);
    assert.deepEqual(
      detail.lots.map((l) => l.sku),
      ["LOT-CHEAP", "LOT-EXPENSIVE"],
    );
    assert.equal(detail.lots[0]?.price, 1500);
    assert.equal(detail.lots[0]?.condition, "Condition B");
    assert.equal(detail.lots[0]?.warehouse, "Aarhus");
    assert.equal(detail.lots[1]?.price, 1650);
    assert.equal(detail.description, "A classic Barolo.");
    assert.equal(detail.is_box, false);
    assert.equal(detail.case_type, "OC");
  });
});
