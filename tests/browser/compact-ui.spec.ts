import { expect, test, type Page } from '@playwright/test';
import { buildEpubFixture } from '../support/fixtures';
import { importStoredBook } from './support';

test.use({ hasTouch: true });

async function touchTargets(page: Page, selector: string) {
  const targets = await page.locator(selector).evaluateAll((elements) =>
    elements
      .map((element) => ({
        label: element.getAttribute('aria-label') ?? element.textContent?.trim(),
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
      }))
      .filter((target) => target.width > 0 && target.height > 0),
  );
  expect(
    targets.every((target) => target.width >= 44 && target.height >= 44),
    JSON.stringify(targets),
  ).toBe(true);
}

for (const width of [320, 390, 768, 1280]) {
  test(`compact views share typography and reachable controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const title =
      'A long imported book title with enough words to demonstrate compact wrapping without losing the complete accessible title';
    await importStoredBook(page, buildEpubFixture({ title, chapters: 2 }), 'compact.epub', title);
    await expect(page.locator('.details h1')).toHaveCSS(
      'font-size',
      width <= 767 ? '24px' : width === 768 ? '28px' : '30.72px',
    );
    const headingSize = await page
      .locator('.details h1')
      .evaluate((element) => getComputedStyle(element).fontSize);
    await touchTargets(page, '.details .button, .details .select-trigger');

    await page.goto('/');
    await expect(page.locator('.library h1')).toHaveCSS('font-size', headingSize);
    await expect(page.locator('.book-title')).toHaveAttribute('title', title);
    await expect(page.locator('.book-title')).toHaveCSS('-webkit-line-clamp', '3');
    await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
    await touchTargets(page, '.library .button, .library-status-tab, .library .select-trigger');
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await touchTargets(page, '#library-filters .button, #library-filters .select-trigger');

    await page.goto('/settings');
    await expect(page.locator('.settings-header h1')).toHaveCSS('font-size', headingSize);
    await touchTargets(
      page,
      '.settings-refined .button, .settings-navigation a, .settings-refined .select-trigger, .settings-refined .accent-swatch, .settings-refined .accent-custom input',
    );
    const sectionSize = await page
      .locator('.settings-refined h2')
      .first()
      .evaluate((element) => getComputedStyle(element).fontSize);
    expect(sectionSize).toBe('18px');

    await page.goto('/stats');
    await expect(page.locator('.stats h1')).toHaveCSS('font-size', headingSize);
    await expect(page.locator('.stats h2').first()).toHaveCSS('font-size', sectionSize);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
  });
}
