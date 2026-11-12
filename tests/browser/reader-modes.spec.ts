import { expect, test, type Page } from '@playwright/test';
import { buildPdfFixture, buildEpubFixture } from '../support/fixtures';
import { chooseSelect, importBook, position } from './support';

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 960 });
});
test.afterEach(() => expect(errors).toEqual([]));
async function settings(page: Page) {
  const menu = page.locator('.reader-settings-popover');
  if (!(await menu.evaluate((el) => (el as HTMLDetailsElement).open)))
    await menu.locator(':scope > summary').click();
}
async function closeSettings(page: Page) {
  await page.getByRole('button', { name: 'Close reader settings' }).click();
}
async function mode(page: Page, name: string) {
  await settings(page);
  await page.getByRole('button', { name, exact: true }).click();
  await closeSettings(page);
}
async function jump(page: Page, number: number, format = 'page') {
  await page.getByRole('spinbutton', { name: `Go to ${format}`, exact: true }).fill(String(number));
  await page.getByRole('button', { name: 'Go to location', exact: true }).click();
}
async function slider(page: Page, name: string, value: string) {
  await page.getByRole('slider', { name, exact: true }).fill(value);
}
const painted = (page: Page) => page.locator('.pdf-scroll canvas[data-render-state="ready"]');

test('PDF facing pages, second-page selection, cover pairing and narrow fallback', async ({
  page,
}, testInfo) => {
  await importBook(
    page,
    buildPdfFixture({ title: 'Facing pages', pageCount: 12 }),
    'facing.pdf',
    'Facing pages',
  );
  await mode(page, 'Facing pages');
  await expect(page.locator('.pdf-scroll')).toHaveAttribute('data-mode', 'double');
  await expect(painted(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(painted(page)).toHaveCount(2);
  await expect(painted(page).nth(0)).toHaveAttribute('aria-label', 'Page 2 of 12');
  await expect(painted(page).nth(1)).toHaveAttribute('aria-label', 'Page 3 of 12');
  await expect(page.locator('.pdf-page[data-page-index="2"] .textLayer')).toContainText(
    'Generated page 3',
  );
  await page.getByRole('tab', { name: 'Notes', exact: true }).click();
  await page.locator('.pdf-page[data-page-index="2"] .textLayer').evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.getByRole('button', { name: 'Highlight selection', exact: true }).click();
  await expect(page.locator('.pdf-page[data-page-index="2"] .pdf-highlight').first()).toBeVisible();
  await settings(page);
  await page.getByText('Page layout', { exact: true }).click();
  await page.getByLabel('Show cover on its own').uncheck();
  await chooseSelect(page.getByRole('combobox', { name: 'Page order', exact: true }), 'rtl');
  await closeSettings(page);
  await jump(page, 1);
  await expect(painted(page).nth(0)).toHaveAttribute('aria-label', 'Page 1 of 12');
  await expect(painted(page).nth(1)).toHaveAttribute('aria-label', 'Page 2 of 12');
  await expect
    .poll(() =>
      painted(page).evaluateAll(
        (nodes) =>
          nodes.length === 2 &&
          nodes[0]!.getBoundingClientRect().x > nodes[1]!.getBoundingClientRect().x,
      ),
    )
    .toBe(true);
  await settings(page);
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('pdf-facing-settings.png'),
  });
  await closeSettings(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.pdf-scroll')).toHaveAttribute('data-mode', 'single');
  await expect(painted(page)).toHaveCount(1);
  await settings(page);
  await expect(page.getByRole('button', { name: 'Facing pages', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('pdf-settings-mobile.png'),
  });
});

test('PDF continuous scroll saves a distant offset, bounds canvases and reopens offline', async ({
  page,
  context,
}) => {
  test.slow();
  await importBook(
    page,
    buildPdfFixture({ title: 'Long scroll', pageCount: 60 }),
    'scroll.pdf',
    'Long scroll',
  );
  await mode(page, 'Continuous scroll');
  await expect(page.locator('.pdf-scroll')).toHaveAttribute('data-mode', 'continuous');
  await expect(page.locator('.pdf-slot')).toHaveCount(60);
  await page.locator('.pdf-scroll').evaluate((el) => {
    const slot = el.querySelector<HTMLElement>('.pdf-slot[data-page-index="29"]')!;
    el.scrollTop = slot.offsetTop + 160;
  });
  await expect.poll(async () => (await position(page)).locatorValue).toMatch(/^29:[1-9]/);
  await expect(page.locator('.pdf-page[data-page-index="29"] .textLayer')).toContainText(
    'Generated page 30',
  );
  await expect.poll(() => painted(page).count()).toBeLessThanOrEqual(6);
  expect(
    await painted(page).evaluateAll((nodes) =>
      nodes.reduce(
        (sum, node) => sum + (node as HTMLCanvasElement).width * (node as HTMLCanvasElement).height,
        0,
      ),
    ),
  ).toBeLessThanOrEqual(8_000_000);
  const saved = await position(page);
  await mode(page, 'Single page');
  await expect(painted(page)).toHaveCount(1);
  await expect(painted(page)).toHaveAttribute('aria-label', 'Page 30 of 60');
  await expect.poll(async () => (await position(page)).locatorValue).toBe(saved.locatorValue);
  await mode(page, 'Continuous scroll');
  await expect.poll(async () => (await position(page)).locatorValue).toBe(saved.locatorValue);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await expect(page.locator('.pdf-scroll')).toHaveAttribute('data-mode', 'continuous');
  await expect.poll(async () => (await position(page)).locatorValue).toBe(saved.locatorValue);
  await expect(page.locator('.pdf-page[data-page-index="29"] .textLayer')).toContainText(
    'Generated page 30',
  );
});

test('PDF fit, rotation, zoom, inversion, focus and keyboard controls', async ({ page }) => {
  await importBook(
    page,
    buildPdfFixture({ title: 'Reading tools', pageCount: 4 }),
    'tools.pdf',
    'Reading tools',
  );
  await jump(page, 3);
  await expect(painted(page)).toHaveAttribute('aria-label', 'Page 3 of 4');
  await settings(page);
  await chooseSelect(page.getByRole('combobox', { name: 'Page fit' }), 'page');
  await expect
    .poll(async () => {
      const canvas = await painted(page).boundingBox();
      const area = await page.locator('.pdf-scroll').boundingBox();
      return !!canvas && !!area && canvas.height <= area.height - 46;
    })
    .toBe(true);
  await page.getByRole('button', { name: 'Rotate clockwise' }).click();
  await expect
    .poll(() =>
      painted(page).evaluate(
        (el) =>
          parseFloat((el as HTMLElement).style.width) /
          parseFloat((el as HTMLElement).style.height),
      ),
    )
    .toBeGreaterThan(1);
  await slider(page, 'PDF zoom', '200');
  await page.getByLabel('Invert page colours').check();
  await expect(painted(page)).toHaveAttribute('data-color-mode', 'inverted');
  await closeSettings(page);
  await expect.poll(async () => (await position(page)).locatorValue).toMatch(/^2:/);
  await page.getByRole('button', { name: 'Focus mode', exact: true }).click();
  await expect(page.locator('.reader-toolbar')).toBeHidden();
  await expect(page.locator('.reader-footer')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('.reader-toolbar')).toBeVisible();
  await page.locator('.pdf-scroll').focus();
  await page.keyboard.press('ArrowRight');
  await expect(painted(page)).toHaveAttribute('aria-label', 'Page 4 of 4');
  await settings(page);
  await page.getByRole('button', { name: 'Reset reading settings' }).click();
  await expect(page.getByRole('slider', { name: 'PDF zoom' })).toHaveValue('100');
  await expect(page.getByRole('button', { name: 'Rotate clockwise' })).toHaveText('0°');
});

test('EPUB modes, typography, section jump and iframe focus shortcuts retain the chapter', async ({
  page,
}, testInfo) => {
  await importBook(
    page,
    buildEpubFixture({ title: 'Typography study', chapters: 4, paragraphs: 80 }),
    'type.epub',
    'Typography study',
  );
  await jump(page, 3, 'section');
  await expect(page.getByRole('spinbutton', { name: 'Go to section' })).toHaveValue('3');
  const chapterFraction = (await position(page)).fraction;
  await mode(page, 'Facing pages');
  const engineAttribute = (name: string) =>
    page
      .locator('foliate-view')
      .evaluate(
        (el, name) => (el as HTMLElement & { renderer: HTMLElement }).renderer.getAttribute(name),
        name,
      );
  await expect.poll(() => engineAttribute('max-column-count')).toBe('2');
  await expect
    .poll(async () => (await position(page)).fraction)
    .toBeGreaterThanOrEqual(chapterFraction - 0.01);
  await settings(page);
  await chooseSelect(page.getByRole('combobox', { name: 'Typeface' }), 'serif');
  await slider(page, 'Text size', '24');
  await page.getByText('Typography & spacing', { exact: true }).click();
  await slider(page, 'Line height', '1.8');
  await slider(page, 'Letter spacing', '0.04');
  await chooseSelect(page.getByRole('combobox', { name: 'Text alignment' }), 'left');
  await chooseSelect(page.getByRole('combobox', { name: 'Theme', exact: true }), 'sepia');
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('epub-typography.png'),
  });
  await closeSettings(page);
  await mode(page, 'Continuous scroll');
  await expect.poll(() => engineAttribute('flow')).toBe('scrolled');
  const frame = page.frames().find((frame) => frame.url().startsWith('blob:'))!;
  await expect(frame.locator('body')).toHaveCSS('font-size', '24px');
  await expect(frame.locator('body')).toHaveCSS('font-family', /Georgia/);
  await expect(page.getByRole('spinbutton', { name: 'Go to section' })).toHaveValue('3');
  await frame.locator('body').press('f');
  await expect(page.locator('.reader-toolbar')).toBeHidden();
  await frame.locator('body').press('Escape');
  await expect(page.locator('.reader-toolbar')).toBeVisible();
  await mode(page, 'Single page');
  await expect.poll(() => engineAttribute('flow')).toBe('paginated');
  await expect.poll(() => engineAttribute('max-column-count')).toBe('1');
  await expect(page.getByRole('spinbutton', { name: 'Go to section' })).toHaveValue('3');
});

test('fixed EPUB clearly exposes only supported layout controls', async ({ page }) => {
  await importBook(
    page,
    buildEpubFixture({
      title: 'Publisher layout',
      fixedLayout: true,
      assets: 'valid',
      chapters: 3,
    }),
    'fixed.epub',
    'Publisher layout',
  );
  await settings(page);
  await expect(page.getByRole('button', { name: 'Continuous scroll', exact: true })).toBeDisabled();
  await expect(page.getByRole('slider', { name: 'Text size', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Facing pages', exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator('foliate-view')
        .evaluate((el) =>
          (el as HTMLElement & { renderer: HTMLElement }).renderer.getAttribute('page-mode'),
        ),
    )
    .toBe('double');
  await page.getByRole('button', { name: 'Single page', exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator('foliate-view')
        .evaluate((el) =>
          (el as HTMLElement & { renderer: HTMLElement }).renderer.getAttribute('page-mode'),
        ),
    )
    .toBe('single');
});

test('full screen keeps custom settings usable and exits with the reader', async ({ page }) => {
  await importBook(
    page,
    buildPdfFixture({ title: 'Full screen', pageCount: 2 }),
    'full.pdf',
    'Full screen',
  );
  if (!(await page.evaluate(() => document.fullscreenEnabled))) {
    await expect(page.getByRole('button', { name: 'Full screen', exact: true })).toHaveCount(0);
    return;
  }
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('reader-shell')))
    .toBe(true);
  await settings(page);
  await chooseSelect(page.getByRole('combobox', { name: 'Page fit' }), 'page');
  await mode(page, 'Continuous scroll');
  await expect(page.locator('.pdf-scroll')).toHaveAttribute('data-mode', 'continuous');
  await page.getByRole('link', { name: '← Close reader' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
});

test('EPUB continuous wheel navigation crosses sections and resumes offline', async ({
  page,
  context,
}) => {
  await importBook(
    page,
    buildEpubFixture({ title: 'Chapter scrolling', chapters: 3, paragraphs: 40 }),
    'chapters.epub',
    'Chapter scrolling',
  );
  await mode(page, 'Continuous scroll');
  const area = await page.locator('foliate-view').boundingBox();
  await page.mouse.move(area!.x + area!.width / 2, area!.y + area!.height / 2);
  await page.mouse.wheel(0, 400);
  await expect
    .poll(() =>
      page
        .locator('foliate-view')
        .evaluate((el) => (el as HTMLElement & { renderer: { start: number } }).renderer.start),
    )
    .toBeGreaterThan(0);
  // Place the native paginator at the section boundary deterministically. A giant
  // synthetic wheel delta is coalesced differently by Firefox's async scrolling.
  await page.locator('foliate-view').evaluate(async (el) => {
    await (
      el as HTMLElement & { renderer: { scrollToAnchor(anchor: number): Promise<void> } }
    ).renderer.scrollToAnchor(1);
  });
  await expect
    .poll(() =>
      page.locator('foliate-view').evaluate((el) => {
        const r = (el as HTMLElement & { renderer: { end: number; viewSize: number } }).renderer;
        return r.end >= r.viewSize - 2;
      }),
    )
    .toBe(true);
  await page.mouse.wheel(0, 300);
  await expect(page.getByRole('spinbutton', { name: 'Go to section' })).toHaveValue('2');
  await page.mouse.wheel(0, 200);
  await expect.poll(async () => (await position(page)).fraction).toBeGreaterThan(0.33);
  const saved = await position(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await expect(page.getByRole('spinbutton', { name: 'Go to section' })).toHaveValue('2');
  await expect
    .poll(async () => Math.abs((await position(page)).fraction - saved.fraction))
    .toBeLessThan(0.01);
});
