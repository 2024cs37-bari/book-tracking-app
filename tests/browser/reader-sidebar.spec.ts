import { expect, test } from '@playwright/test';
import { buildEpubFixture, buildPdfFixture } from '../support/fixtures';
import { importBook, position } from './support';

let browserErrors: string[];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

test('the reader sidebar toggles, switches panels, and persists', async ({ page }) => {
  await importBook(
    page,
    buildEpubFixture({ title: 'Sidebar Book', chapters: 3, paragraphs: 10 }),
    'sidebar.epub',
    'Sidebar Book',
  );

  const sidebar = page.locator('.reader-sidebar');
  const toggle = page.getByRole('button', { name: 'Toggle sidebar' });

  // Open by default.
  await expect(sidebar).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // The toggle button collapses it.
  await toggle.click();
  await expect(sidebar).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // The 's' key reopens it from the reader chrome (not while typing).
  await page.getByRole('link', { name: '← Close reader' }).focus();
  await page.keyboard.press('s');
  await expect(sidebar).toBeVisible();

  // The Pages panel lists EPUB sections (reflowable, so no thumbnails).
  await page.getByRole('tab', { name: 'Pages' }).click();
  await expect(sidebar.locator('.reader-pages-list')).toBeVisible();

  // The Contents panel shows the book navigation.
  await page.getByRole('tab', { name: 'Contents' }).click();
  await expect(sidebar.getByRole('navigation', { name: 'Book contents' })).toBeVisible();

  // Open state persists across a reload.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await expect(page.locator('.reader-sidebar')).toBeVisible();
});

test('PDF thumbnail completion preserves a pointer gesture already in progress', async ({
  page,
}) => {
  await importBook(
    page,
    buildPdfFixture({ title: 'Thumbnail gesture', pageCount: 3 }),
    'thumbnail-gesture.pdf',
    'Thumbnail gesture',
  );
  // Delay the second thumbnail's real encoding completion, leaving its preview
  // placeholder mounted until the user has pressed the pointer on it.
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    let thumbnails = 0;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      if (this.width <= 180 && this.height <= 180 && ++thumbnails === 2) {
        original.call(
          this,
          (blob) => {
            (window as unknown as { finishThumbnail: () => void }).finishThumbnail = () =>
              callback(blob);
          },
          type,
          quality,
        );
      } else original.call(this, callback, type, quality);
    };
  });
  await page.getByRole('tab', { name: 'Pages', exact: true }).click();
  const target = page.getByRole('button', { name: '2', exact: true });
  await expect(target.locator('.reader-thumb-placeholder')).toBeVisible();
  await page.waitForFunction(() => 'finishThumbnail' in window);
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.evaluate(() =>
    (window as unknown as { finishThumbnail: () => void }).finishThumbnail(),
  );
  await expect(target.locator('img')).toBeVisible();
  await page.mouse.up();
  await expect(target).toHaveAttribute('aria-current', 'true');
  await page.getByRole('button', { name: 'Close sidebar', exact: true }).click();
  await expect(page.locator('.pdf-scroll canvas[data-render-state="ready"]')).toHaveAttribute(
    'aria-label',
    'Page 2 of 3',
  );
  await expect.poll(async () => (await position(page)).locatorValue).toMatch(/^1:/);
});

test('reader appearance is reachable on mobile and dismisses without moving the saved page', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await importBook(
    page,
    buildPdfFixture({ title: 'A long title for a small and quiet reading screen', pageCount: 3 }),
    'reader-appearance.pdf',
    'A long title for a small and quiet reading screen',
  );
  // Page turns remain reachable even while the mobile navigation panel is open.
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.pdf-scroll canvas[data-render-state="ready"]')).toHaveAttribute(
    'aria-label',
    'Page 2 of 3',
  );
  const menu = page.locator('.reader-settings-popover');
  const trigger = menu.locator('summary').first();
  await trigger.click();
  await expect(page.getByLabel('Theme', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Margins', { exact: true })).toBeHidden();
  await page.getByText('Page layout', { exact: true }).click();
  await expect(page.getByLabel('Margins', { exact: true })).toBeVisible();
  await page.getByLabel('Margins', { exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(menu).not.toHaveAttribute('open', '');
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('button', { name: 'Toggle sidebar' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await trigger.click();
  // The sidebar heading is behind the appearance sheet on narrow screens;
  // the toolbar toggle is an exposed outside target for ordinary dismissal.
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  await expect(menu).not.toHaveAttribute('open', '');
  await expect(page.locator('.pdf-scroll canvas[data-render-state="ready"]')).toHaveAttribute(
    'aria-label',
    'Page 2 of 3',
  );
  await expect.poll(async () => (await position(page)).locatorValue).toMatch(/^1:/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
