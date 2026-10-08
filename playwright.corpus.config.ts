import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

export default defineConfig({
  ...base,
  testDir: './tests/corpus',
  timeout: 90_000,
  use: { ...base.use, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true },
});
