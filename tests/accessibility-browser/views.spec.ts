import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { buildEpubFixture } from '../support/fixtures';
import { chooseSelect, importStoredBook } from '../browser/support';

const TITLE = 'Accessible library test book with a meaningful longer title';
async function scan(page: Page, reader = false) {
  // Measure the settled interface, not a partially transparent entry frame.
  // Keep motion enabled so the normal disclosure/focus paths are exercised.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.playState === 'running' &&
                animation.effect?.getComputedTiming().iterations !== Infinity,
            ).length,
      ),
    )
    .toBe(0);
  let axe = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']);
  // Imported publication markup and the third-party renderer are separate
  // content. This suite audits application controls surrounding that content.
  if (reader) axe = axe.exclude('.reader-surface');
  const result = await axe.analyze();
  const violations = result.violations.filter(
    (item) => item.impact === 'serious' || item.impact === 'critical',
  );
  expect(
    violations.map((item) => ({
      id: item.id,
      description: item.description,
      nodes: item.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
    })),
  ).toEqual([]);
}
async function noOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          (rect.right > window.innerWidth + 1 || rect.left < -1)
        );
      })
      .slice(0, 8)
      .map((element) => ({
        tag: element.tagName,
        class: element.className,
        rect: element.getBoundingClientRect().toJSON(),
      })),
  }));
  expect(overflow.scroll, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.width + 1);
}
async function seed(page: Page) {
  await importStoredBook(
    page,
    buildEpubFixture({ title: TITLE, chapters: 3, paragraphs: 15 }),
    'accessibility.epub',
    TITLE,
  );
  await page.getByLabel('New shelf name').fill('Keyboard accessible shelf');
  await page.getByRole('button', { name: 'Add shelf', exact: true }).click();
  await expect(page.getByLabel('Keyboard accessible shelf')).toBeChecked();
  await page.getByLabel('New tag', { exact: true }).fill('A'.repeat(200));
  await page.getByRole('button', { name: 'Add tag', exact: true }).click();
  await expect(
    page.getByRole('button', { name: `Remove tag ${'A'.repeat(200)}`, exact: true }),
  ).toBeVisible();
  const bookPath = new URL(page.url()).pathname;
  await page.evaluate(async (bookId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('book-reader');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('sessions', 'readwrite');
      transaction.objectStore('sessions').put({
        id: 'accessibility-fixture-session',
        bookId,
        startedAt: Date.now() - 60000,
        durationS: 60,
        startFraction: 0.1,
        endFraction: 0.4,
        deviceId: 'accessibility-fixture',
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, bookPath.split('/').at(-1)!);
  return bookPath;
}

for (const width of [1280, 390]) {
  test(`populated main views and reader chrome meet automated checks at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const bookPath = await seed(page);
    await scan(page);
    await noOverflow(page);
    await page.getByRole('button', { name: 'Edit details', exact: true }).click();
    await scan(page);
    await noOverflow(page);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    for (const path of ['/', '/settings', '/stats']) {
      await page.goto(path);
      await page.locator('.app-nav').waitFor();
      if (path === '/') await expect(page.locator('.library-toolbar')).toBeVisible();
      else await expect(page.locator('main h1')).toBeVisible();
      if (path === '/stats') await expect(page.locator('.reading-days-table')).toBeVisible();
      await scan(page);
      await noOverflow(page);
      if (path === '/') {
        await page.getByRole('button', { name: 'Filters', exact: true }).click();
        await scan(page);
        await noOverflow(page);
        const format = page.getByRole('combobox', { name: 'Format', exact: true });
        await format.click();
        await expect(page.getByRole('listbox')).toBeVisible();
        await scan(page);
        await noOverflow(page);
        await format.press('Escape');
        await expect(page.locator('#library-filters')).toBeVisible();
        await page.getByRole('button', { name: 'Filters', exact: true }).click();
      }
      if (path === '/settings') {
        await page.getByText('Advanced diagnostics', { exact: true }).click();
        await scan(page);
        await noOverflow(page);
        const rename = page.getByRole('button', {
          name: 'Rename shelf Keyboard accessible shelf',
          exact: true,
        });
        await rename.click();
        await expect(page.getByLabel('New shelf name')).toBeFocused();
        await scan(page);
        await noOverflow(page);
        await page.getByRole('button', { name: 'Cancel rename', exact: true }).click();
        await expect(rename).toBeFocused();
      }
    }
    await page.goto(bookPath);
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    await scan(page, true);
    await noOverflow(page);
    await page.getByRole('button', { name: 'Close sidebar', exact: true }).click();
    await scan(page, true);
    await noOverflow(page);
    await page.locator('.reader-settings-summary').click();
    await page.getByText('Typography & spacing', { exact: true }).click();
    await scan(page, true);
    await noOverflow(page);
    await page.getByRole('button', { name: 'Close reader settings' }).click();
    await page.getByRole('button', { name: 'Focus mode', exact: true }).click();
    await expect(page.getByRole('button', { name: /Exit focus/ })).toBeFocused();
    await scan(page, true);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Focus mode', exact: true })).toBeFocused();
  });
}

test('skip link and reader panels support a predictable keyboard path', async ({ page }) => {
  const bookPath = await seed(page);
  await page.goto('/');
  await expect(page.locator('.app-nav')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('main');
  await page.goto(bookPath);
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  const contents = page.getByRole('tab', { name: 'Contents', exact: true });
  await contents.focus();
  await page.keyboard.press('ArrowRight');
  const pages = page.getByRole('tab', { name: 'Pages', exact: true });
  await expect(pages).toBeFocused();
  await expect(pages).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Listen', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(contents).toBeFocused();
  const resize = page.getByRole('separator', { name: 'Resize sidebar' });
  await resize.focus();
  await page.keyboard.press('ArrowRight');
  await expect(resize).toHaveAttribute('aria-valuenow', '320');
  const close = page.getByRole('button', { name: 'Close sidebar', exact: true });
  await close.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Toggle sidebar', exact: true })).toBeFocused();
});

test('dark theme and a supported accent preset keep controls readable', async ({ page }) => {
  await seed(page);
  await page.goto('/settings');
  await chooseSelect(page.getByRole('combobox', { name: 'Theme', exact: true }), 'dark');
  await scan(page);
  await page.getByRole('button', { name: 'Amber', exact: true }).click();
  await scan(page);
});
