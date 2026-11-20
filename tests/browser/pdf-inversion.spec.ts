import { expect, test, type Locator, type Page } from '@playwright/test';
import { buildImageHeavyPdfFixture } from '../support/fixtures';
import { importBook, position } from './support';

async function openSettings(page: Page) {
  const wrapper = page.locator('.reader-settings-popover');
  const trigger = wrapper.getByRole('button', { name: 'Reader settings', exact: true });
  await trigger.click();
  await expect(wrapper.locator('dialog.reader-settings')).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
}
async function jump(page: Page, number: number) {
  await page.getByRole('spinbutton', { name: 'Go to page', exact: true }).fill(String(number));
  await page.getByRole('button', { name: 'Go to location', exact: true }).click();
}
async function raster(canvas: Locator) {
  return canvas.evaluate(async (element) => {
    const canvas = element as HTMLCanvasElement;
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    return {
      hash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data))).join(','),
      corner: Array.from(data.slice(0, 4)),
    };
  });
}

for (const mode of ['Single page', 'Facing pages', 'Continuous scroll']) {
  test(`PDF inversion survives repeated toggles at 400% in ${mode}`, async ({ page }, testInfo) => {
    test.slow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('crash', () => errors.push('Browser page crashed'));
    await page.setViewportSize({ width: 1600, height: 1000 });
    await importBook(
      page,
      buildImageHeavyPdfFixture(24),
      'Inversion stress.pdf',
      'Inversion stress',
    );
    await openSettings(page);
    await page.getByRole('button', { name: mode, exact: true }).click();
    await page.getByRole('slider', { name: 'PDF zoom', exact: true }).fill('400');
    await page.getByRole('button', { name: 'Close reader settings' }).click();
    await jump(page, 11);
    const canvas = page.locator('.pdf-page[data-page-index="10"] > canvas');
    await expect(canvas).toHaveAttribute('data-color-mode', 'original');
    await expect.poll(async () => (await position(page)).locatorValue).toMatch(/^10:/);
    const original = await raster(canvas);
    expect(original.corner).toEqual([255, 255, 255, 255]);
    const saved = (await position(page)).locatorValue;

    await openSettings(page);
    const invert = page.getByLabel('Invert page colours', { exact: true });
    for (let cycle = 0; cycle < 3; cycle++) {
      await invert.check();
      await expect(canvas).toHaveAttribute('data-color-mode', 'inverted');
      const inverted = await raster(canvas);
      expect(inverted.corner).toEqual([0, 0, 0, 255]);
      expect(inverted.hash).not.toBe(original.hash);
      // Force a real browser composite, including the enlarged canvas.
      await page.screenshot();
      await expect(canvas).toHaveCSS('filter', 'none');
      await invert.uncheck();
      await expect(canvas).toHaveAttribute('data-color-mode', 'original');
      expect(await raster(canvas)).toEqual(original);
    }
    await expect.poll(async () => (await position(page)).locatorValue).toBe(saved);

    // Supersede a colour render with rotation and further colour changes.
    await invert.check();
    await page.getByRole('button', { name: 'Rotate clockwise' }).click();
    await invert.uncheck();
    await invert.check();
    await page.getByRole('button', { name: 'Close reader settings' }).click();
    await jump(page, 19);
    const destination = page.locator('.pdf-page[data-page-index="18"] > canvas');
    await expect(destination).toHaveAttribute('data-color-mode', 'inverted');
    expect((await raster(destination)).corner).toEqual([0, 0, 0, 255]);
    await expect(page.locator('.pdf-page[data-page-index="18"] .textLayer')).toContainText(
      'Stress page 19',
    );
    await expect
      .poll(() => page.locator('.pdf-page > canvas[data-color-mode="original"]').count())
      .toBe(0);
    const canvases = page.locator('.pdf-page > canvas');
    expect(
      await canvases.evaluateAll((elements) =>
        elements.reduce(
          (sum, el) => sum + (el as HTMLCanvasElement).width * (el as HTMLCanvasElement).height,
          0,
        ),
      ),
    ).toBeLessThanOrEqual(8_000_000);
    await page.reload();
    await expect(destination).toHaveAttribute('data-color-mode', 'inverted');
    expect((await raster(destination)).corner).toEqual([0, 0, 0, 255]);
    await page.screenshot({ path: testInfo.outputPath('inversion-after-reopen.png') });
    await page.getByRole('link', { name: 'Close reader' }).click();
    await expect(page.locator('.pdf-page > canvas')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
