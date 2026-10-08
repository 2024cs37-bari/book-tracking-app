import { expect, test } from '@playwright/test';
import { unzipSync, strFromU8 } from 'fflate';
import { buildEpubFixture } from '../support/fixtures';

test('CSP is inherited by blob book frames and blocks inline scripts', async ({ page }) => {
  await page.goto('/');
  await page.locator('.app-nav').waitFor();
  const chapter = strFromU8(
    unzipSync(buildEpubFixture({ hostileScript: true }))['OEBPS/chapter1.xhtml']!,
  );
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('script-src')) violations.push(message.text());
  });
  await page.evaluate((content) => {
    const iframe = document.createElement('iframe');
    iframe.id = 'csp-book';
    iframe.src = URL.createObjectURL(new Blob([content], { type: 'application/xhtml+xml' }));
    document.body.append(iframe);
  }, chapter);
  await expect(page.frameLocator('#csp-book').locator('p')).toHaveText('Content.');
  expect(await page.evaluate(() => 'bookScriptExecuted' in globalThis)).toBe(false);
  expect(
    await page
      .frameLocator('#csp-book')
      .locator('body')
      .evaluate(() => 'bookScriptExecuted' in globalThis),
  ).toBe(false);
  expect(violations.length).toBeGreaterThan(0);
});
