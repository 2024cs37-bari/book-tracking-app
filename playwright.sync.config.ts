import { defineConfig } from '@playwright/test';

const clientPort = Number(process.env.SYNC_TEST_CLIENT_PORT ?? 4193);
const apiPort = Number(process.env.SYNC_TEST_API_PORT ?? 8793);
const origin = `http://127.0.0.1:${clientPort}`;

export default defineConfig({
  testDir: './tests/sync-browser',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: '.sync-test-results',
  use: { baseURL: origin, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', channel: 'chromium' } }],
  webServer: [
    {
      command: 'node server/browser-test-server.mjs',
      url: `http://127.0.0.1:${apiPort}/api/v1/sync/pull?since=0&limit=1`,
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      command: `npm run build -- --mode test --outDir .sync-test-dist && npm run preview -- --outDir .sync-test-dist --host 127.0.0.1 --port ${clientPort} --strictPort`,
      env: { VITE_SYNC_URL: `http://127.0.0.1:${apiPort}/api`, VITE_DICTIONARY_ENABLED: 'false' },
      url: origin,
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
