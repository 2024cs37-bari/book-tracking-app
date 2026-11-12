import { defineConfig } from '@playwright/test';
const port = Number(process.env.ACCESSIBILITY_TEST_PORT ?? 4195);
export default defineConfig({
  testDir: './tests/accessibility-browser',
  workers: 1,
  timeout: 90_000,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', channel: 'chromium' } }],
  outputDir: '.accessibility-test-results',
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    env: { VITE_SYNC_URL: '', VITE_DICTIONARY_ENABLED: 'false' },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
