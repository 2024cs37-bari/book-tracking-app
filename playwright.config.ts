import { defineConfig } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4191);
const buildDirectory = '.browser-test-dist';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}` },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', channel: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: `npm run build -- --outDir ${buildDirectory} && npm run preview -- --outDir ${buildDirectory} --host 127.0.0.1 --port ${port} --strictPort`,
    env: { VITE_SYNC_URL: '', VITE_DICTIONARY_ENABLED: 'true' },
    url: `http://127.0.0.1:${port}`,
    timeout: 60_000,
    // Always validate the build from this checkout; an existing preview may
    // contain stale assets or a different sync/privacy configuration.
    reuseExistingServer: false,
  },
});
