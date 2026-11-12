# Guava by Journey — directory release notes

First ChatGPT directory submission for Guava product lookup.

- New endpoint `https://mcp.journeyfoods.io/apps/guava/mcp` on the existing host. `https://mcp.journeyfoods.io/mcp` is unchanged.
- Read-only tools: search by name or typed barcode, get one product, compare two to four products, and `get_profile`.
- The Guava Score, ingredients, nutrition, and price context are returned only when the connected catalog sends them. Nothing is estimated.
- Until `GUAVA_API_BASE_URL` points at the real catalog, the tools say the catalog is not connected and return no products.
- Searches return at most 4 results unless the caller is signed in with full catalog access.
- OAuth 2.1 with PKCE S256, and text-only results plus a result list, comparison table, and product panel.

This package does not deploy the Worker and does not change DNS. Test fixtures in the repository are labeled `test-fixture` and are not catalog data.
