# Journey Foods — ChatGPT submission checklist

Endpoint to submit: `https://mcp.journeyfoods.io/apps/journey-foods/mcp`

The origin stays `https://mcp.journeyfoods.io`. Do not submit a new host. `plugin.json` and `mcp.json` point at this path. `test-cases.json` has five positive prompts and three negative prompts. They describe behavior. They are not live catalog fixtures.

Humans still need to do the following before review. This repository does not deploy, change DNS, or store secrets.

1. Auth0 is the identity provider. Tenant `dev-ssk71qghv0z5qp7s.us.auth0.com`. Issuer `https://dev-ssk71qghv0z5qp7s.us.auth0.com/` (trailing slash required). JWKS `https://dev-ssk71qghv0z5qp7s.us.auth0.com/.well-known/jwks.json`. Tokens are RS256. This app's audience is `https://mcp.journeyfoods.io/apps/journey-foods/mcp`. Scopes are `catalog:read` and `profile:read`, with offline access enabled. Dynamic client registration, Client ID Metadata Documents, and the Resource Parameter Compatibility Profile are already on. Database and Google connections are domain-level. RBAC is off. These values are in `worker/wrangler.jsonc` and are not secrets. Protected-resource metadata advertises this issuer.
2. Full search still needs a subscription claim. Add an Auth0 Action on the post-login / credentials exchange flow that reads the user's Journey subscription and sets the access-token claim `https://journeyfoods.io/full_catalog` to boolean `true` only when that subscription is active. Do not turn RBAC on for this. If the claim is missing or not true, the server returns at most 4 search results. The reviewer demo account needs that claim, or the reviewer will only see the 4-result preview.
3. Deploy the Worker yourself after review. Do not change the scheme or host of `mcp.journeyfoods.io`.
4. Publish a logo you have rights to use, then add `logo_url` in the submission portal and in `plugin.json`.
5. Publish a privacy policy, terms of service, and a support URL. Paste those URLs into the portal and `plugin.json`. The privacy policy must cover account data returned by `get_profile` (opaque id, and name or email only when the identity provider sends them).
6. Create a reviewer demo account with full catalog access and sample data. It must sign in without MFA, SMS, or email codes, from outside the company network.
7. Put the OpenAI domain-challenge token in `OPENAI_APPS_CHALLENGE`. The Worker serves it as plain text at `/.well-known/openai-apps-challenge`. Until the token is set, that path returns `not_configured`.
8. Record a walkthrough video of a signed-out 4-result search, the account note, a signed-in full search, a supplier card, a comparison, and a price chart.
9. Complete organization verification in the OpenAI dashboard and submit with an account that has `api.apps.write`. Scan tools after deploy and confirm `readOnlyHint`, `destructiveHint`, and `openWorldHint` match the server.
10. Confirm the widget CSP is still empty. The panels do not fetch any domain. If a later panel loads an image or font, add only that origin.

API-key clients can keep calling `https://mcp.journeyfoods.io/mcp`.
