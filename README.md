# Journey AI MCP Server: food and CPG supplier, ingredient and commodity price data for AI agents

**Journey AI** is the official [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server from [Journey Foods](https://journeyfoods.io). It gives AI agents and assistants such as Claude, ChatGPT, Cursor, VS Code and Perplexity read-only access to Journey's food and CPG data: supplier search and comparison, ingredient nutrition and sustainability profiles, commodity reference prices with history and forecasts, Journey Labs verified test results, and (for signed-in customers) your own product formulations.

- Hosted server: `https://mcp.journeyfoods.io/mcp` (Streamable HTTP)
- Local package: `npx -y @journeyfoods/mcp` (stdio)
- Docs: [docs.journeyfoods.io](https://docs.journeyfoods.io) · Website: [journeyfoods.io](https://journeyfoods.io)

Every tool is read-only. Journey AI never creates, changes or deletes data.

## Get an API key

Get a free trial key at [price.journeyfoods.io](https://price.journeyfoods.io). Developer API keys for ingredient data are at [dev.journeyfoods.io](https://dev.journeyfoods.io).

## Setup

You can use the hosted server (nothing to install) or run the package locally with `npx`. Ready-made configs are in [`examples/`](examples).

### Claude (claude.ai and Claude Desktop)
- **Hosted:** Settings → Connectors → Add custom connector. Use the URL `https://mcp.journeyfoods.io/mcp` and send your key in the `x-api-key` header.
- **Local (Claude Desktop):** add [`examples/claude-desktop.json`](examples/claude-desktop.json) to `claude_desktop_config.json`, then restart Claude. That block sets `JOURNEY_PRICE_API_KEY` (price tools; base `https://price.journeyfoods.io`). Add `JOURNEY_API_KEY` from [dev.journeyfoods.io](https://dev.journeyfoods.io) in the same `env` object for ingredient tools (base `https://devapi.journeyfoods.io`). Supplier tools use the hosted server unless you set `JOURNEY_SUPPLIER_API_BASE_URL`.

### Claude Code
```bash
claude mcp add --transport http journey https://mcp.journeyfoods.io/mcp --header "x-api-key: YOUR_JOURNEY_API_KEY"
```

### ChatGPT
ChatGPT connectors need OAuth sign-in, which is coming soon on the hosted server, along with a ChatGPT directory listing. Until then, use Journey AI from any of the clients below.

### Cursor
Add [`examples/cursor-mcp.json`](examples/cursor-mcp.json) to `.cursor/mcp.json` (hosted). For local use, use the `npx` block from the Claude Desktop example.

### VS Code
Add [`examples/vscode-mcp.json`](examples/vscode-mcp.json) to `.vscode/mcp.json`. VS Code asks for your key and keeps it out of the file.

### Perplexity
Plugins → Add custom → Connector → Add MCP connector → Remote. Use the URL `https://mcp.journeyfoods.io/mcp`, choose API key authentication, and paste your key.

### Windsurf, Cline, Zed and other MCP clients
Point any client that supports Streamable HTTP at `https://mcp.journeyfoods.io/mcp` with the `x-api-key` header (see [`examples/remote-generic.json`](examples/remote-generic.json)). For stdio clients, run `npx -y @journeyfoods/mcp` with `JOURNEY_PRICE_API_KEY` set. Add `JOURNEY_API_KEY` for ingredient tools. Those are different keys.

### Local HTTP server
```bash
# Price tools. Base defaults to https://price.journeyfoods.io
JOURNEY_PRICE_API_KEY=... npx -y @journeyfoods/mcp --http   # serves http://127.0.0.1:3000/mcp

# Ingredient tools also need a developer API key. Base defaults to https://devapi.journeyfoods.io
# The price feed key is not sent to the developer API.
JOURNEY_PRICE_API_KEY=... JOURNEY_API_KEY=... npx -y @journeyfoods/mcp

npx -y @journeyfoods/mcp --help
```

`JOURNEY_API_BASE_URL` overrides `https://devapi.journeyfoods.io` (ingredients, `x-api-key`). `JOURNEY_PRICE_API_BASE_URL` overrides `https://price.journeyfoods.io` (`/api/v1/commodities`). Supplier profiles are only on an internal backend that needs a service key. Local npx does not default a supplier URL and does not send your API key there. Unless you set `JOURNEY_SUPPLIER_API_BASE_URL`, supplier tools point you at the hosted server `https://mcp.journeyfoods.io/mcp`.

## Tools

| Tool | What it does |
|---|---|
| `search_suppliers` | Find food and CPG suppliers by name, ingredient, category, region or certification |
| `get_supplier` | Full supplier profile: website, country, locations, categories, certifications, verification status |
| `compare_suppliers` | Compare two to five suppliers side by side, including what they share |
| `search_ingredients` | Search the Journey ingredient database, with nutrition and sustainability scores |
| `get_ingredient` | Ingredient profile: nutrition per 100 g, scores, nutrients, allergens and attributes |
| `get_ingredient_price` | Reference price, recent history and optional forecast for a commodity such as cocoa, sugar or coffee |
| `list_price_series` | Every ingredient and commodity Journey publishes prices for (names and units only) |
| `search_products` | Search your own products and formulations (signed-in Journey accounts) |
| `get_product` | One of your products: summary, ingredients and nutrition panel |
| `verify_lab_result` | Check whether an ingredient, product or supplier has a Journey Labs verified result |

If a data source needs something this process does not have, the tool says what to set. Ingredient tools without `JOURNEY_API_KEY` link to [dev.journeyfoods.io](https://dev.journeyfoods.io). Price tools without `JOURNEY_PRICE_API_KEY` link to [price.journeyfoods.io](https://price.journeyfoods.io). Supplier tools without a supplier API base point at `https://mcp.journeyfoods.io/mcp`. Product tools need a signed-in Journey app account.

## Limits

| Plan | What you can see | Requests |
|---|---|---|
| Free (Explore) | 200 products, 200 ingredients, 10 suppliers and 25 lab results per company or account (distinct records, lifetime), each under 2% | 10 per minute |
| Fresh | 2% of each data type. The supplier network is not included | 60 per minute |
| Supplier, Growth, Group, Startup | 2% of each data type (suppliers, ingredients, products, lab results) | 60 per minute |
| Enterprise | Uncapped while the subscription is active or trialing | 300 per minute |

When you reach a limit, the tool tells you and links to upgrade options. For full data access, [contact Journey](https://journeyfoods.io/contact) about a contract.

## Configuration

See [`.env.example`](.env.example). Keys come from the environment, and no keys are stored in code. Each key is only sent to the service that issued it. The developer API defaults to `https://devapi.journeyfoods.io` (`x-api-key`). The price feed defaults to `https://price.journeyfoods.io` (`/api/v1/commodities`). Supplier data has no default URL. The policy file format is shown in [`policy.example.json`](policy.example.json).

## Development

```bash
npm install
npm test        # tests use mock data only, no network
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Release

Push a `v*` tag, such as `v0.2.1`, to publish that commit. [`.github/workflows/publish.yml`](.github/workflows/publish.yml) runs on GitHub Actions with Node 22:

```bash
npm ci && npm test && npm publish --provenance --access public
```

The workflow uses npm Trusted Publishing (`permissions: id-token: write`). It does not use an `NPM_TOKEN`. Before the first tag, add this repository and `publish.yml` as a trusted publisher for `@journeyfoods/mcp` on npmjs.com. Tag the commit whose `package.json` version you want to ship (`v0.2.1` publishes `0.2.1`). `prepublishOnly` builds the package and runs the tests again before upload.

## License

[MIT](LICENSE) © Journey Foods

mcp-name: io.journeyfoods/journey-ai
