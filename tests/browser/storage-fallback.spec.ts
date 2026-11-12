import { expect, test } from '@playwright/test';

test('durable IndexedDB fallback does not claim originals are memory-only', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, 'getDirectory', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.locator('.banner-warning')).toContainText('durable IndexedDB');
  await expect(page.locator('.banner-warning')).not.toContainText('lost when this page is closed');
  await page.getByText('Advanced diagnostics', { exact: true }).click();
  await expect(page.getByText('indexeddb (durable)', { exact: true })).toBeVisible();
});
