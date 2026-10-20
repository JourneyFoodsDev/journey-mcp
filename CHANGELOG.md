# Changelog

## Unreleased
- Self-serve data access is exactly 2% of each dataset per company or account. The Startup 4,000 ingredient cap is removed. Fresh has no supplier-network allowance. Supplier is a paid plan. Enterprise is uncapped only while status is active or trialing.
- Supplier, ingredient, product and lab calls forward a signed `x-journey-end-user` when `JOURNEY_END_USER_SIGNING_SECRET` is set. API-key identity prefers the price feed account's company or account id so a new key does not reset the cap.

## 0.2.0 (2026-10-19)
- First public release.
- 10 read-only tools: search_suppliers, get_supplier, compare_suppliers, search_ingredients, get_ingredient, get_ingredient_price, list_price_series, search_products, get_product, verify_lab_result.
- Hosted Streamable HTTP server at https://mcp.journeyfoods.io/mcp and local stdio/HTTP via `npx -y @journeyfoods/mcp`.
- Per-account free-tier caps and rate limits, and structured usage events with no arguments or data.
- `--help` and `--version` flags.
