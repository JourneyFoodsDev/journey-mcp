# Journey Foods — directory release notes

First ChatGPT directory submission for the Journey Foods CPG lookup.

- New endpoint `https://mcp.journeyfoods.io/apps/journey-foods/mcp` on the existing host. The current public endpoint `https://mcp.journeyfoods.io/mcp` is unchanged and still accepts `x-api-key`.
- Read-only supplier, ingredient, price-index, and lab-verification tools, plus `get_profile`.
- Searches return at most 4 results unless the caller is signed in with full catalog access. The note links to `https://www.journeyfoods.io/mcp` and does not start a purchase.
- OAuth 2.1 protected-resource metadata and a builtin authorization server that requires PKCE S256. Login stays closed until an identity provider is connected.
- Inline MCP Apps panels for the result list, record card, comparison table, and price chart. Every tool still returns text.

This package does not deploy the Worker and does not change DNS.
