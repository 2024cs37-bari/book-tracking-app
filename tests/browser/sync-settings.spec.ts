import { expect, test } from '@playwright/test';

let browserErrors: string[];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

test('settings shows sync as not configured when no server URL is set', async ({ page }) => {
  await page.goto('/settings');
  await page.locator('.app-nav').waitFor();

  await expect(page.getByRole('heading', { name: 'Sync', exact: true })).toBeVisible();
  await expect(page.getByText('not configured for this build')).toBeVisible();
  // With no server, there is no "Sync now" action.
  await expect(page.getByRole('button', { name: 'Sync now' })).toHaveCount(0);
});
