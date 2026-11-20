import { expect, test, type Locator, type Page } from '@playwright/test';
import { buildEpubFixture, buildPdfFixture } from '../support/fixtures';
import { chooseSelect, importBook, position } from './support';

type Format = 'epub' | 'pdf';

const viewports = [
  { name: 'desktop', width: 1440, height: 960 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'short landscape', width: 844, height: 390 },
] as const;

let errors: string[] = [];
test.beforeEach(({ page }) => {
  errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
});
test.afterEach(() => expect(errors).toEqual([]));

async function openReader(page: Page, format: Format) {
  const title = `${format.toUpperCase()} settings drawer`;
  await importBook(
    page,
    format === 'epub'
      ? buildEpubFixture({ title, chapters: 3, paragraphs: 12 })
      : buildPdfFixture({ title, pageCount: 3 }),
    `drawer.${format}`,
    title,
  );
  const jump = page.getByRole('spinbutton', {
    name: format === 'pdf' ? 'Go to page' : 'Go to section',
    exact: true,
  });
  await jump.fill('2');
  await page.getByRole('button', { name: 'Go to location', exact: true }).click();
  await expect(jump).toHaveValue('2');
  await expect.poll(async () => (await position(page))?.fraction ?? 0).toBeGreaterThan(0.2);
  if (format === 'pdf') {
    await expect(page.locator('.pdf-scroll canvas[data-render-state="ready"]')).toHaveAttribute(
      'aria-label',
      'Page 2 of 3',
    );
  }
  return position(page);
}

async function openDrawer(page: Page) {
  const wrapper = page.locator('.reader-settings-popover');
  const trigger = wrapper.getByRole('button', { name: 'Reader settings', exact: true });
  const drawer = wrapper.locator('dialog.reader-settings-drawer');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute('open', '');
  await expect(drawer).toHaveAccessibleName('Reader settings');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('html')).toHaveClass(/\breader-settings-open\b/);
  const id = await drawer.getAttribute('id');
  expect(id).toBeTruthy();
  await expect(trigger).toHaveAttribute('aria-controls', id!);
  expect(
    await drawer.evaluate(
      (element) =>
        element.matches(':modal') &&
        [...document.querySelectorAll('[id]')].filter((node) => node.id === element.id).length ===
          1,
    ),
  ).toBe(true);
  const close = drawer.getByRole('button', { name: 'Close reader settings', exact: true });
  await expect(close).toBeFocused();
  return { drawer, trigger, close };
}

async function fullHeightRightDrawer(page: Page, drawer: Locator) {
  await expect
    .poll(() =>
      drawer.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          Math.abs(rect.top) <= 1 &&
          Math.abs(rect.bottom - innerHeight) <= 1 &&
          Math.abs(rect.right - innerWidth) <= 1 &&
          rect.left > 0 &&
          rect.width <= 460 &&
          rect.width >= Math.min(280, innerWidth - 32)
        );
      }),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
}

async function dismissed(drawer: Locator, trigger: Locator) {
  await expect(drawer).toBeHidden();
  await expect(drawer).not.toHaveAttribute('open', '');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
  await expect(trigger.page().locator('html')).not.toHaveClass(/\breader-settings-open\b/);
  await expect(trigger.page().getByRole('listbox')).toHaveCount(0);
}

async function savedPosition(page: Page, saved: Awaited<ReturnType<typeof position>>) {
  await expect.poll(async () => (await position(page)).locatorKind).toBe(saved.locatorKind);
  await expect.poll(async () => (await position(page)).locatorValue).toBe(saved.locatorValue);
}

for (const format of ['epub', 'pdf'] as const) {
  for (const viewport of viewports) {
    test(`${format} settings is a modal right drawer on ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const saved = await openReader(page, format);
      const { drawer, trigger, close } = await openDrawer(page);
      await fullHeightRightDrawer(page, drawer);

      // Both boundaries wrap inside the dialog, never into the reading chrome.
      const reset = drawer.getByRole('button', { name: 'Reset reading settings', exact: true });
      await close.press('Shift+Tab');
      await expect(reset).toBeFocused();
      await reset.press('Tab');
      await expect(close).toBeFocused();
      const sidebarToggle = page.getByRole('button', { name: 'Toggle sidebar', exact: true });
      const sidebarState = await sidebarToggle.getAttribute('aria-expanded');
      await sidebarToggle.evaluate((element) => (element as HTMLElement).focus());
      await expect(close).toBeFocused();
      expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(
        true,
      );

      // Scrolling advanced controls must not scroll the pinned heading away.
      const body = drawer.locator('.reader-settings-body');
      await expect(body).toHaveCSS('overflow-y', 'auto');
      await drawer
        .locator('.reader-layout-options > summary')
        .filter({ hasText: format === 'pdf' ? 'Page layout' : 'Typography & spacing' })
        .click();
      await reset.scrollIntoViewIfNeeded();
      await expect(close).toBeInViewport();
      if (viewport.name === 'short landscape') {
        expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      }
      await fullHeightRightDrawer(page, drawer);

      // Portaled options must be within the native modal's active subtree and
      // clickable with an ordinary pointer, not a forced or synthetic commit.
      const theme = drawer.getByRole('combobox', { name: 'Theme', exact: true });
      await theme.click();
      const choices = drawer.getByRole('listbox', { name: 'Theme', exact: true });
      await expect(choices).toBeVisible();
      expect(
        await choices.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.left >= 0 &&
            rect.top >= 0 &&
            rect.right <= innerWidth &&
            rect.bottom <= innerHeight
          );
        }),
      ).toBe(true);
      await chooseSelect(theme, 'sepia');
      await expect(theme).toBeFocused();
      await expect(drawer).toBeVisible();
      await theme.press('Enter');
      await theme.press('End');
      await theme.press('Escape');
      await expect(theme).toHaveAttribute('aria-expanded', 'false');
      await expect(theme).toHaveAttribute('data-value', 'sepia');
      await expect(theme).toBeFocused();
      await expect(drawer).toBeVisible();
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await theme.press('Escape');
      await dismissed(drawer, trigger);
      await savedPosition(page, saved);

      const reopened = await openDrawer(page);
      await expect(
        reopened.drawer.getByRole('combobox', { name: 'Theme', exact: true }),
      ).toHaveAttribute('data-value', 'sepia');
      // Native backdrop clicks must dismiss without activating any underlying
      // chrome. Desktop also clicks exactly over the inert sidebar button.
      const rect = await drawer.boundingBox();
      const toggleRect = await sidebarToggle.boundingBox();
      expect(rect).not.toBeNull();
      expect(toggleRect).not.toBeNull();
      const targetX = toggleRect!.x + toggleRect!.width / 2;
      await page.mouse.click(
        targetX < rect!.x ? targetX : rect!.x / 2,
        toggleRect!.y + toggleRect!.height / 2,
      );
      await dismissed(drawer, trigger);
      await expect(sidebarToggle).toHaveAttribute('aria-expanded', sidebarState!);
      await savedPosition(page, saved);

      await page.reload();
      await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
      await savedPosition(page, saved);
      const restored = await openDrawer(page);
      await expect(
        restored.drawer.getByRole('combobox', { name: 'Theme', exact: true }),
      ).toHaveAttribute('data-value', 'sepia');
      await restored.close.click();
      await dismissed(restored.drawer, restored.trigger);
    });
  }

  test(`${format} route teardown removes an open drawer and its select portal`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    const saved = await openReader(page, format);
    const { drawer } = await openDrawer(page);
    await drawer.getByRole('combobox', { name: 'Theme', exact: true }).click();
    await expect(drawer.getByRole('listbox', { name: 'Theme', exact: true })).toBeVisible();
    // Browser history changes the SPA route while the native modal is still
    // open; clicking a background link would incorrectly bypass modality.
    await page.goBack();
    await expect(page).toHaveURL(/\/book\//);
    await expect(page.locator('.reader-settings-popover')).toHaveCount(0);
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(page.locator('.select-menu')).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveClass(/\breader-settings-open\b/);
    const read = page.getByRole('button', { name: 'Read', exact: true });
    await expect(read).toBeVisible();
    await read.click();
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    await savedPosition(page, saved);
    const reopened = await openDrawer(page);
    await reopened.close.click();
    await dismissed(reopened.drawer, reopened.trigger);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect.poll(async () => (await position(page)).locatorValue).not.toBe(saved.locatorValue);
  });

  test(`${format} reduced motion keeps drawer dismissal and page position immediate`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    const saved = await openReader(page, format);
    const { drawer, trigger } = await openDrawer(page);
    await expect(drawer).toHaveCSS('animation-name', 'none');
    await expect(drawer).toHaveCSS('transition-duration', '0s');
    const theme = drawer.getByRole('combobox', { name: 'Theme', exact: true });
    await theme.click();
    await expect(drawer.getByRole('listbox')).toHaveCSS('animation-name', 'none');
    await theme.press('Escape');
    await expect(page.locator('.select-menu')).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await theme.press('Escape');
    await dismissed(drawer, trigger);
    await savedPosition(page, saved);
  });
}

test('fullscreen PDF keeps the native drawer and its mouse-selectable popup usable', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Fullscreen automation is reliable in Chromium.');
  const saved = await openReader(page, 'pdf');
  test.skip(!(await page.evaluate(() => document.fullscreenEnabled)), 'Fullscreen is unavailable.');
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('reader-shell')))
    .toBe(true);
  const { drawer, trigger, close } = await openDrawer(page);
  await fullHeightRightDrawer(page, drawer);
  await chooseSelect(drawer.getByRole('combobox', { name: 'Page fit', exact: true }), 'page');
  await expect(drawer).toBeVisible();
  await close.click();
  await dismissed(drawer, trigger);
  await savedPosition(page, saved);
  await page.getByRole('link', { name: '← Close reader', exact: true }).click();
  await expect(page.locator('.reader-settings-popover')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
});
