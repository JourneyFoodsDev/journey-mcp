# Journey Foods — ChatGPT submission checklist

Endpoint to submit: `https://mcp.journeyfoods.io/apps/journey-foods/mcp`

The origin stays `https://mcp.journeyfoods.io`. Do not submit a new host. `plugin.json` and `mcp.json` point at this path. `test-cases.json` has five positive prompts and three negative prompts. They describe behavior. They are not live catalog fixtures.

Humans still need to do the following before review. This repository does not deploy, change DNS, or store secrets.

1. Choose an identity provider that supports OAuth 2.1 authorization code, PKCE S256, the `resource` parameter, and either Client ID Metadata Documents or dynamic client registration. Auth0 and Stytch are the providers OpenAI documents. Set `OAUTH_ISSUER` and `OAUTH_JWKS_URL` to that provider so protected-resource metadata advertises it. Confirm the provider returns `iss` on every authorization response and copies `resource` into the access token audience.
2. The builtin authorization server on this host implements the same protocol for tests. It refuses login until an identity provider is connected, and it keeps clients in memory. Do not submit that closed login as the reviewer path. If you instead make this host the issuer, set `OAUTH_JWT_PRIVATE_JWK` in the secret store and connect a real login implementation. Never commit the key.
3. Deploy the Worker yourself after review. Do not change the scheme or host of `mcp.journeyfoods.io`.
4. Publish a logo you have rights to use, then add `logo_url` in the submission portal and in `plugin.json`.
5. Publish a privacy policy, terms of service, and a support URL. Paste those URLs into the portal and `plugin.json`. The privacy policy must cover account data returned by `get_profile` (opaque id, and name or email only when the identity provider sends them).
6. Create a reviewer demo account with full catalog access and sample data. It must sign in without MFA, SMS, or email codes, from outside the company network.
7. Put the OpenAI domain-challenge token in `OPENAI_APPS_CHALLENGE`. The Worker serves it as plain text at `/.well-known/openai-apps-challenge`. Until the token is set, that path returns `not_configured`.
8. Record a walkthrough video of a signed-out 4-result search, the account note, a signed-in full search, a supplier card, a comparison, and a price chart.
9. Complete organization verification in the OpenAI dashboard and submit with an account that has `api.apps.write`. Scan tools after deploy and confirm `readOnlyHint`, `destructiveHint`, and `openWorldHint` match the server.
10. Confirm the widget CSP is still empty. The panels do not fetch any domain. If a later panel loads an image or font, add only that origin.

API-key clients can keep calling `https://mcp.journeyfoods.io/mcp`.
