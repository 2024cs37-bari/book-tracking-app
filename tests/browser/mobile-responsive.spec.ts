import { expect, test, type Page } from '@playwright/test';
import { buildEpubFixture, buildPdfFixture } from '../support/fixtures';
import { importBook } from './support';

test.use({ hasTouch: true, deviceScaleFactor: 2 });

async function withinViewport(page: Page, selector: string) {
  await expect
    .poll(() =>
      page.locator(selector).evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left >= -1 &&
          rect.top >= -1 &&
          rect.right <= innerWidth + 1 &&
          rect.bottom <= innerHeight + 1
        );
      }),
    )
    .toBe(true);
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 844, height: 390 },
]) {
  for (const format of ['epub', 'pdf'] as const) {
    test(`${format} reader fits a touch viewport at ${viewport.width}×${viewport.height}`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize(viewport);
      const title = `Mobile ${format} reader`;
      await importBook(
        page,
        format === 'epub'
          ? buildEpubFixture({ title, chapters: 3, paragraphs: 12 })
          : buildPdfFixture({ title, pageCount: 3 }),
        `mobile.${format}`,
        title,
      );
      const toggle = page.getByRole('button', { name: 'Toggle sidebar', exact: true });
      await expect(toggle).toHaveAttribute('aria-expanded', String(viewport.width > 767));
      if (viewport.width <= 767) {
        await expect(page.locator('.reader-sidebar')).toHaveCount(0);
        await expect(page.locator('.reader-scrim')).toHaveCount(0);
        await toggle.click();
      }
      await expect(page.locator('.reader-sidebar')).toBeVisible();
      await withinViewport(page, '.reader-sidebar');
      await page.getByRole('tab', { name: 'Contents', exact: true }).click();
      if (format === 'epub') {
        await expect(page.getByRole('navigation', { name: 'Book contents' })).toBeVisible();
      } else {
        await expect(
          page.getByText('No table of contents available.', { exact: true }),
        ).toBeVisible();
      }
      await page.getByRole('tab', { name: 'Notes', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Bookmark this position' })).toBeVisible();
      await page.getByRole('button', { name: 'Close sidebar', exact: true }).click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await withinViewport(page, '.reader-toolbar');
      await withinViewport(page, '.reader-footer');
      await withinViewport(page, '.reader-nav');
      await withinViewport(page, '.reader-page-jump');
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        ),
      ).toBe(true);
      const touchTargets = page.locator(
        '.reader-toolbar .reader-icon-button, .reader-close, .reader-nav .reader-icon-button, .reader-page-jump button',
      );
      const targetSizes = await touchTargets.evaluateAll((elements) =>
        elements
          .map((element) => ({
            label: element.getAttribute('aria-label'),
            width: element.getBoundingClientRect().width,
            height: element.getBoundingClientRect().height,
          }))
          .filter((target) => target.width > 0 && target.height > 0),
      );
      expect(
        targetSizes.every((target) => target.width >= 44 && target.height >= 44),
        JSON.stringify(targetSizes),
      ).toBe(true);
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      if (format === 'pdf') {
        await expect(page.locator('.pdf-scroll canvas[data-render-state="ready"]')).toHaveAttribute(
          'aria-label',
          'Page 2 of 3',
        );
      }
      await page
        .getByRole('spinbutton', { name: `Go to ${format === 'pdf' ? 'page' : 'section'}` })
        .fill('3');
      await page.getByRole('button', { name: 'Go to location', exact: true }).click();
      if (format === 'pdf') {
        await expect(page.locator('.pdf-scroll canvas[data-render-state="ready"]')).toHaveAttribute(
          'aria-label',
          'Page 3 of 3',
        );
      } else {
        await expect(page.locator('foliate-view')).toBeVisible();
      }
      const settings = page.locator('.reader-settings-popover');
      const settingsTrigger = settings.getByRole('button', {
        name: 'Reader settings',
        exact: true,
      });
      const settingsDialog = settings.locator('dialog.reader-settings');
      await settingsTrigger.click();
      await expect(settingsDialog).toBeVisible();
      await expect(settingsTrigger).toHaveAttribute('aria-expanded', 'true');
      await withinViewport(page, '.reader-settings-popover dialog');
      await page.getByRole('button', { name: 'Close reader settings', exact: true }).click();
      await expect(settingsDialog).toBeHidden();
      await expect(settingsTrigger).toHaveAttribute('aria-expanded', 'false');
      await expect(settingsTrigger).toBeFocused();
      await withinViewport(page, '.reader-footer');
      await page.screenshot({ path: test.info().outputPath(`${format}-mobile-reader.png`) });
      expect(errors).toEqual([]);
    });
  }
}
