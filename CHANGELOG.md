# Changelog

## Unreleased
- Self-serve data access is exactly 2% of each dataset per company or account. The Startup 4,000 ingredient cap is removed. Fresh has no supplier-network allowance. Supplier is a paid plan. Enterprise is uncapped only while status is active or trialing.
- Supplier, ingredient, product and lab calls forward a signed `x-journey-end-user` when `JOURNEY_END_USER_SIGNING_SECRET` is set. API-key identity prefers the price feed account's company or account id so a new key does not reset the cap.

## 0.2.1 (2026-10-26)
- `npx -y @journeyfoods/mcp` with only `JOURNEY_PRICE_API_KEY` set connects to the price feed. `JOURNEY_PRICE_API_BASE_URL` defaults to `https://price.journeyfoods.io` and `JOURNEY_API_BASE_URL` defaults to `https://devapi.journeyfoods.io`. Set either variable to override.
- The price feed and the developer API do not accept each other's keys. `JOURNEY_PRICE_API_KEY` is not sent to the developer API. Ingredient tools say to set `JOURNEY_API_KEY` and link to `https://dev.journeyfoods.io`. Price tools without a price key say to set `JOURNEY_PRICE_API_KEY` and link to `https://price.journeyfoods.io`.
- There is no public supplier route on the developer or price APIs. Supplier tools without `JOURNEY_SUPPLIER_API_BASE_URL` point at the hosted server `https://mcp.journeyfoods.io/mcp` instead of saying "not connected".

## 0.2.0 (2026-10-19)
- First public release.
- 10 read-only tools: search_suppliers, get_supplier, compare_suppliers, search_ingredients, get_ingredient, get_ingredient_price, list_price_series, search_products, get_product, verify_lab_result.
- Hosted Streamable HTTP server at https://mcp.journeyfoods.io/mcp and local stdio/HTTP via `npx -y @journeyfoods/mcp`.
- Per-account free-tier caps and rate limits, and structured usage events with no arguments or data.
- `--help` and `--version` flags.
