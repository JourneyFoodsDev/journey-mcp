# Guava by Journey — directory release notes

First ChatGPT directory submission for Guava product lookup.

- New endpoint `https://mcp.journeyfoods.io/apps/guava/mcp` on the existing host. `https://mcp.journeyfoods.io/mcp` is unchanged.
- Read-only tools: search by name or typed barcode, get one product, compare two to four products, and `get_profile`.
- The Guava Score, ingredients, nutrition, and price context are returned only when the connected catalog sends them. Nothing is estimated.
- The catalog is the D1 snapshot `journey-fallback-guava` written by `guava-catalog-sync`. This Worker reads `guava_p` and product `docs` when `GUAVA_D1` is bound. It does not calculate a Guava Score. Current rows store `guavaScore` as null, so the score is omitted. `GET /apps/guava/v1/products` is the read-only HTTP catalog on this same host.
- Searches return at most 4 results unless the caller is signed in with full catalog access.
- OAuth 2.1 with PKCE S256, and text-only results plus a result list, comparison table, and product panel.

This package does not deploy the Worker and does not change DNS. Test fixtures in the repository are labeled `test-fixture` and are not catalog data.
