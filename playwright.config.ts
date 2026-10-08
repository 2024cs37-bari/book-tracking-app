import { defineConfig } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4173);

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
    command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
  },
});
