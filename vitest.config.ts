import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // workers-oauth-provider imports cloudflare:workers; inline it so the alias applies.
  test: { server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } } },
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(new URL('./test/cloudflare-workers-stub.ts', import.meta.url)),
    },
  },
});
