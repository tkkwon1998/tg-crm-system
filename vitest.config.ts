import { defineConfig } from 'vitest/config';

/**
 * Root Vitest config for the pure-logic unit tests (no Cloudflare account/runtime
 * needed). The extract Workflow imports the `cloudflare:workers` virtual module,
 * which only exists in the Workers runtime — we intercept it with a tiny stub so
 * the pure exported functions (evaluateGuardrails, decide, parseExtraction,
 * deriveSignals) can be imported and tested in plain Node.
 */
const stub = new URL('./tests/stubs/cloudflare-workers.ts', import.meta.url).pathname;

export default defineConfig({
  plugins: [
    {
      name: 'stub-cloudflare-workers',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'cloudflare:workers') return stub;
        return null;
      },
    },
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
