import { expect, test, type Locator, type Page } from '@playwright/test';
import { buildPdfFixture } from '../support/fixtures';
import { chooseSelect, importBook, position } from './support';

let browserErrors: string[] = [];
test.beforeEach(({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

async function activeOption(control: Locator, value: string): Promise<void> {
  const option = control
    .page()
    .getByRole('option')
    .and(control.page().locator(`[data-value="${value}"]`));
  await expect(option).toBeVisible();
  await expect(control).toHaveAttribute(
    'aria-activedescendant',
    (await option.getAttribute('id'))!,
  );
  await expect(control).toBeFocused();
}

async function containedMenu(page: Page): Promise<void> {
  const listbox = page.getByRole('listbox');
  await expect(listbox).toBeVisible();
  await expect
    .poll(() =>
      listbox.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
        );
      }),
    )
    .toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function optionInsideMenu(option: Locator): Promise<void> {
  await expect
    .poll(() =>
      option.evaluate((element) => {
        const optionRect = element.getBoundingClientRect();
        const menuRect = element.parentElement!.getBoundingClientRect();
        return optionRect.top >= menuRect.top && optionRect.bottom <= menuRect.bottom;
      }),
    )
    .toBe(true);
}

test('custom select previews clamped arrow and Home/End navigation, then commits with Enter or Space', async ({
  page,
}) => {
  await page.goto('/');
  const sort = page.getByRole('combobox', { name: 'Sort by', exact: true });
  await expect(sort).toHaveAttribute('data-value', 'title');
  await sort.focus();
  await sort.press('ArrowDown');
  await activeOption(sort, 'title');
  await sort.press('ArrowUp');
  await activeOption(sort, 'title');
  await sort.press('ArrowDown');
  await activeOption(sort, 'author');
  await expect(sort).toHaveAttribute('data-value', 'title');
  await sort.press('End');
  await activeOption(sort, 'added_asc');
  await sort.press('ArrowDown');
  await activeOption(sort, 'added_asc');
  await sort.press('Home');
  await activeOption(sort, 'title');
  await sort.press('End');
  await sort.press('ArrowUp');
  await activeOption(sort, 'added_desc');
  await sort.press('Enter');
  await expect(sort).toHaveAttribute('data-value', 'added_desc');
  await expect(sort).toHaveText('Recently added');
  await expect(sort).toHaveAttribute('aria-expanded', 'false');
  await expect(sort).toBeFocused();
  await sort.press('Space');
  await activeOption(sort, 'added_desc');
  await sort.press('Home');
  await sort.press('Space');
  await expect(sort).toHaveAttribute('data-value', 'title');
  await expect(page.getByRole('listbox')).toHaveCount(0);
});

test('Escape, Tab and outside interaction cancel custom select previews without trapping focus', async ({
  page,
}) => {
  await page.goto('/');
  const filters = page.getByRole('button', { name: 'Filters', exact: true });
  await filters.click();
  const panel = page.locator('#library-filters');
  const show = page.getByRole('combobox', { name: 'Show', exact: true });
  const status = page.getByRole('combobox', { name: 'Reading status', exact: true });
  const format = page.getByRole('combobox', { name: 'Format', exact: true });
  await show.click();
  await show.press('ArrowDown');
  await activeOption(show, 'archived');
  await show.press('Escape');
  await expect(show).toHaveAttribute('data-value', 'active');
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await expect(show).toBeFocused();
  await expect(panel).toBeVisible();
  // A visual exit may still exist, but it must stop participating in keyboard
  // and assistive-technology interaction as soon as cancellation completes.
  expect(await page.getByRole('listbox').count()).toBe(0);
  expect(
    await page
      .locator('.select-menu[data-state="closed"]')
      .evaluateAll((menus) =>
        menus.every(
          (menu) => menu.hasAttribute('inert') && menu.getAttribute('aria-hidden') === 'true',
        ),
      ),
  ).toBe(true);
  await show.press('Enter');
  await show.press('ArrowDown');
  await show.press('Tab');
  await expect(status).toBeFocused();
  await expect(show).toHaveAttribute('data-value', 'active');
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await status.click();
  await expect(status).toHaveAttribute('aria-expanded', 'true');
  await format.click();
  await expect(status).toHaveAttribute('aria-expanded', 'false');
  await expect(format).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('listbox')).toHaveCount(1);
  await format.press('End');
  const search = page.getByRole('searchbox', { name: 'Search', exact: true });
  await search.click();
  await expect(search).toBeFocused();
  await expect(format).toHaveAttribute('aria-expanded', 'false');
  await expect(format).toHaveAttribute('data-value', 'all');
  await expect(panel).toBeVisible();
});

test('custom select typeahead matches multiple letters and cycles repeated initial letters', async ({
  page,
}) => {
  await page.goto('/');
  const sort = page.getByRole('combobox', { name: 'Sort by', exact: true });
  await sort.focus();
  await sort.press('r');
  await sort.press('e');
  await activeOption(sort, 'added_desc');
  await expect(sort).toHaveAttribute('data-value', 'title');
  await sort.press('Enter');
  await expect(sort).toHaveAttribute('data-value', 'added_desc');
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  const show = page.getByRole('combobox', { name: 'Show', exact: true });
  await show.focus();
  await show.press('a');
  await activeOption(show, 'archived');
  await show.press('a');
  await activeOption(show, 'all');
  await show.press('a');
  await activeOption(show, 'active');
  await show.press('Escape');
  await expect(show).toHaveAttribute('data-value', 'active');
});

test('portaled reader colour choices preserve the mobile settings drawer and saved page', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await importBook(
    page,
    buildPdfFixture({ title: 'Select in reader', pageCount: 3 }),
    'select.pdf',
    'Select in reader',
  );
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect.poll(async () => (await position(page)).locatorValue).toMatch(/^1:/);
  const saved = await position(page);
  const wrapper = page.locator('.reader-settings-popover');
  const drawer = wrapper.locator('dialog.reader-settings');
  const trigger = wrapper.getByRole('button', { name: 'Reader settings', exact: true });
  await trigger.click();
  await expect(drawer).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const theme = drawer.getByRole('combobox', { name: 'Theme', exact: true });
  await theme.click();
  await containedMenu(page);
  await expect(drawer.getByRole('listbox', { name: 'Theme', exact: true })).toBeVisible();
  await chooseSelect(theme, 'sepia');
  await expect(drawer).toBeVisible();
  await expect(theme).toBeFocused();
  await theme.press('Enter');
  await theme.press('End');
  await activeOption(theme, 'dark');
  await theme.press('Escape');
  await expect(theme).toHaveAttribute('data-value', 'sepia');
  await expect(theme).toHaveAttribute('aria-expanded', 'false');
  await expect(drawer).toBeVisible();
  await theme.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('button', { name: 'Toggle sidebar', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(page.locator('.pdf-scroll canvas[data-render-state="ready"]')).toHaveAttribute(
    'aria-label',
    'Page 2 of 3',
  );
  await expect.poll(async () => (await position(page)).locatorValue).toBe(saved.locatorValue);
});

test('custom menu stays within a short mobile viewport and keeps keyboard targets reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 420 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  const format = page.getByRole('combobox', { name: 'Format', exact: true });
  await format.scrollIntoViewIfNeeded();
  await format.click();
  await containedMenu(page);
  await format.press('End');
  await activeOption(format, 'cbz');
  const last = page.getByRole('option').and(page.locator('[data-value="cbz"]'));
  await optionInsideMenu(last);
  await format.press('Enter');
  await expect(format).toHaveAttribute('data-value', 'cbz');
  await expect(format).toBeFocused();
});

test('a dropdown follows its visible anchor when the document scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 420 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  const show = page.getByRole('combobox', { name: 'Show', exact: true });
  await show.click();
  await activeOption(show, 'active');
  const before = await page.evaluate(() => {
    const before = window.scrollY;
    window.scrollBy(0, before >= 24 ? -24 : 24);
    return before;
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).not.toBe(before);
  await containedMenu(page);
  await expect(show).toHaveAttribute('aria-expanded', 'true');
  await show.press('ArrowDown');
  await activeOption(show, 'archived');
  await show.press('Escape');
  await expect(show).toHaveAttribute('data-value', 'active');
});

test('dynamic speech voices remain reachable in a long menu without scrolling the reading page', async ({
  page,
}) => {
  // Supply the platform voice-list boundary; the real controller and selector
  // still subscribe to voiceschanged and handle navigation and selection.
  await page.addInitScript(() => {
    let names = ['Initial narrator'];
    const synth = Object.assign(new EventTarget(), {
      getVoices: () =>
        names.map((name) => ({
          name,
          lang: 'en-US',
          default: false,
          localService: true,
          voiceURI: name,
        })),
      speak: () => undefined,
      cancel: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
    });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: class {},
    });
    window.addEventListener('test-voices', (event) => {
      names = (event as CustomEvent<string[]>).detail;
      synth.dispatchEvent(new Event('voiceschanged'));
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await importBook(
    page,
    buildPdfFixture({ title: 'Voice choices', pageCount: 2 }),
    'voices.pdf',
    'Voice choices',
  );
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  await page.getByRole('tab', { name: 'Listen', exact: true }).click();
  const voice = page.getByRole('combobox', { name: 'Voice', exact: true });
  await voice.click();
  await expect(page.getByRole('option')).toHaveCount(2);
  const names = Array.from(
    { length: 40 },
    (_, index) =>
      `Narrator ${String(index + 1).padStart(2, '0')} — English, enhanced offline natural reading voice`,
  );
  await page.evaluate(
    (detail) => window.dispatchEvent(new CustomEvent('test-voices', { detail })),
    names,
  );
  await expect(page.getByRole('option')).toHaveCount(41);
  await containedMenu(page);
  const scrollPosition = () =>
    page.evaluate(() => ({
      page: window.scrollY,
      reader: document.querySelector('.pdf-scroll')?.scrollTop,
      sidebar: document.querySelector('.reader-sidebar-body')?.scrollTop,
    }));
  const before = await scrollPosition();
  await voice.press('End');
  const lastLabel = `${names.at(-1)!} (en-US)`;
  await optionInsideMenu(page.getByRole('option', { name: lastLabel, exact: true }));
  await activeOption(voice, names.at(-1)!);
  await voice.press('Enter');
  await expect(voice).toHaveAttribute('data-value', names.at(-1)!);
  expect(await scrollPosition()).toEqual(before);
  await voice.press('Enter');
  const selected = page.getByRole('option', { name: lastLabel, exact: true });
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  await optionInsideMenu(selected);
  // A platform refresh can replace the list while the menu is open. The
  // active descendant must reference a remaining option, never a detached one.
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('test-voices', {
        detail: ['Replacement narrator'],
      }),
    ),
  );
  await expect(page.getByRole('option')).toHaveCount(2);
  await voice.press('End');
  await activeOption(voice, 'Replacement narrator');
  await voice.press('Enter');
  await expect(voice).toHaveAttribute('data-value', 'Replacement narrator');
  expect(await scrollPosition()).toEqual(before);
});

test('reduced motion removes dropdown animation and preserves immediate keyboard dismissal', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const sort = page.getByRole('combobox', { name: 'Sort by', exact: true });
  await sort.click();
  const listbox = page.getByRole('listbox');
  await expect(listbox).toBeVisible();
  await expect(listbox).toHaveCSS('animation-name', 'none');
  await expect(sort).toHaveCSS('transition-duration', '0s');
  await expect(sort.locator('.select-chevron')).toHaveCSS('transition-duration', '0s');
  await sort.press('End');
  await sort.press('Escape');
  expect(await page.locator('.select-menu').count()).toBe(0);
  await expect(sort).toHaveAttribute('data-value', 'title');
  await expect(sort).toBeFocused();
});
