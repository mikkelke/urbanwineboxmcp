# urbanwineboxmcp

An [MCP](https://modelcontextprotocol.io) server for **urbanwinebox.com**, exposing its wine
catalog — and, optionally, one account's order history, wishlist and cart — to MCP clients such
as Claude.

> Unofficial. This talks to the same GraphQL endpoint the urbanwinebox.com website uses. Use
> responsibly and at your own risk.

Searching and browsing work with no account at all. Order history, wishlist, viewing the cart,
and editing the cart all require login, and cart edits are further gated behind an explicit
opt-in (see [Environment variables](#environment-variables)).

## Tools

| Tool | Access | What it does |
|---|---|---|
| `search_wines` | Public | Search the catalog by free text, wine_type, country, district, producer, bottle_size, vintage, price range, condition or category. Returns compact price-range summaries. |
| `get_wine` | Public | Full detail for one wine by `sku`, `url_key` or `url`, including every currently listed lot (price, condition, warehouse), cheapest first. |
| `list_categories` | Public | The real category tree, plus the small facet option lists (`wine_type`, `country`, `bottle_size`) usable as `search_wines` filters — kept separate from the tree. |
| `get_orders` | Login | List past orders, newest first, paged. |
| `get_order_details` | Login | Full line items for one past order by its order number. |
| `get_wishlist` | Login | The account's wishlist items. |
| `get_cart` | Login | Current cart lines and totals, plus the URL to pay in a browser. |
| `add_to_cart` | Login + cart writes enabled | Add exactly one unit of a specific lot to the cart. |
| `remove_from_cart` | Login + cart writes enabled | Remove one line from the cart. |

## Catalog model: one wine, many lots

Every wine on urbanwinebox.com is a *grouped* product (its sku ends in `_GROUPED`): a listing for
the wine itself, backed by one or more *lots* — individually priced, individually conditioned
`SimpleProduct` children, each a single physical bottle or case. `search_wines` returns one
summary per wine, with a price range across its current lots. `get_wine` returns the full lot
list (`lots[]`), each with its own sku, price, condition and warehouse, cheapest first.

`add_to_cart` takes both `parent_sku` (the wine) and `lot_sku` (one specific lot from
`get_wine`'s `lots[]`), and always adds exactly **one** unit — each lot is a single,
non-repeatable physical item, never a stackable SKU. On every call, the server re-fetches
`parent_sku` live and re-verifies that `lot_sku` is currently one of its lots before adding it
(lots sell out), and refuses anything that looks like a wine's own (parent) sku.

## No checkout — pay in browser

This server has no checkout, payment or order-placement tools, and never will: `add_to_cart` and
`remove_from_cart` are the only cart mutations it exposes. Every cart response includes
`cart_url` — open it in a browser, signed in as the same account, to review and pay.

## Why no guest cart

urbanwinebox.com has guest checkout disabled, and a cart built through the API under a guest
session has no logged-out purchase path to hand off to in a browser. So every cart tool —
including just viewing it — requires login; there is no anonymous cart mode.

## Environment variables

| Variable | Required for | Purpose |
|---|---|---|
| `URBANWINEBOX_EMAIL` | `get_orders`, `get_order_details`, `get_wishlist`, `get_cart`, `add_to_cart`, `remove_from_cart` | Account email. |
| `URBANWINEBOX_PASSWORD` | (same as above) | Account password. |
| `URBANWINEBOX_ENABLE_CART_WRITES` | `add_to_cart`, `remove_from_cart` | Set to `1` to register the two cart-write tools. Without it the server is read-only even with credentials set — they simply don't appear in the tool list. |
| `MCP_TRANSPORT` | — | `stdio` (default) or `http`. |
| `MCP_HTTP_PORT` | with `MCP_TRANSPORT=http` | Port to listen on. |
| `MCP_HTTP_HOST` | — | Defaults to `127.0.0.1`. Must be loopback (`127.0.0.0/8`, `::1`, or `localhost`) — refused otherwise. The process holds one account's login for its whole lifetime, so it must never be reachable beyond localhost. |

Credentials are optional: omit both to run anonymously (catalog tools only; the login-gated
tools still appear but return a clear "login required" error if called).

## Install

```bash
npm install
npm run build
```

### Use with Claude Code

From a local build:

```bash
claude mcp add urbanwinebox -- node /path/to/urbanwineboxmcp/dist/index.js
```

With login and cart writes enabled:

```bash
claude mcp add urbanwinebox \
  -e URBANWINEBOX_EMAIL=you@example.com \
  -e URBANWINEBOX_PASSWORD=your-password \
  -e URBANWINEBOX_ENABLE_CART_WRITES=1 \
  -- node /path/to/urbanwineboxmcp/dist/index.js
```

Straight from GitHub, no local clone or build:

```bash
claude mcp add urbanwinebox -- npx -y github:mikkelke/urbanwineboxmcp
```

## Development

```bash
npm run dev        # run from source with auto-reload (tsx watch)
npm run typecheck  # tsc --noEmit
npm test           # unit tests against a mocked GraphQL endpoint
npm run inspect    # launch the MCP Inspector against the server
```
```

`UWB_LIVE_TEST=1 npm test` additionally runs a read-only smoke test against the live
urbanwinebox.com API (a search and a single product lookup — no login, no mutations).

## Notes / internals

- **Transport:** stdio by default. The server logs only to stderr — stdout is the JSON-RPC
  channel.
- **Session:** login (`generateCustomerToken`) is lazy and only attempted by login-gated tools;
  catalog browsing is always anonymous. The token is cached and refreshed proactively, and
  reactively on an authentication error (at most one retry per call). Invalid credentials are
  latched after the first rejection — the server won't keep hammering the login endpoint — until
  the process is restarted.
- **Availability:** there is no live stock field; a lot being listed is the only availability
  signal this API exposes, so `lots_available` and friends are labelled as inferred, not live
  stock.
