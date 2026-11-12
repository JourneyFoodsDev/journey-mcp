# Guava by Journey — ChatGPT submission checklist

Endpoint to submit: `https://mcp.journeyfoods.io/apps/guava/mcp`

Same origin as the existing Journey server: `https://mcp.journeyfoods.io`. Submit this path on its own. `plugin.json`, `mcp.json`, and `test-cases.json` are the submission notes. The five positive and three negative cases describe behavior. They do not assert real products or scores.

Humans still need to do the following. This repository does not deploy, change DNS, or store secrets.

1. Choose the identity provider (see the Journey Foods checklist). Set `OAUTH_ISSUER` and `OAUTH_JWKS_URL`. The builtin authorization server refuses login until that provider is connected, and it is not a reviewer demo by itself.
2. Deploy the Worker so the `GUAVA_D1` binding is attached. That database is `journey-fallback-guava` (`1edc14fd-bfec-4897-85d9-b9bd630d7dd9`), the snapshot `guava-catalog-sync` writes. There is no separate public Guava API today. After deploy, search and product detail are `https://mcp.journeyfoods.io/apps/guava/v1/products`. The stored `guavaScore` is null on current rows, so the tool omits it instead of calculating one. Nutrition score and price are returned only when the snapshot has them.
3. Deploy the Worker yourself. Do not change the scheme or host.
4. Add a logo you have rights to use (`logo_url`).
5. Publish privacy, terms, and support URLs and paste them into the portal and `plugin.json`. Privacy copy should say that product lookup returns catalog fields, and that `get_profile` returns an opaque id plus name or email only when the identity provider sends them.
6. Create a reviewer demo account with full catalog access, sample products already in the catalog, and no MFA or extra verification. It must work outside the company network.
7. Set `OPENAI_APPS_CHALLENGE` so `/.well-known/openai-apps-challenge` returns that token. Do not invent one.
8. Record a walkthrough: name search, typed barcode, a product panel where a missing score stays missing, a comparison, the signed-out 4-result note, and a signed-in full search.
9. Complete organization verification and scan tools after deploy. Confirm the read-only annotations.
10. Keep the widget CSP empty unless a panel starts loading a remote asset. Today the panels fetch nothing.

The existing API-key endpoint `https://mcp.journeyfoods.io/mcp` is a separate server for current clients. Guava's `search_products` is the consumer catalog, not a customer's private formulations.
