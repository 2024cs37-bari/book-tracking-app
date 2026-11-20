import { expect, test } from '@playwright/test';
import { buildImageHeavyPdfFixture } from '../support/fixtures';
import { importStoredBook, position } from './support';

test('a high-resolution scanned PDF paints its cover and opens on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const bytes = buildImageHeavyPdfFixture(3, { imageWidth: 2400, imageHeight: 3200 });
  await importStoredBook(page, bytes, 'high-resolution-scan.pdf', 'high-resolution-scan');
  const cover = page.locator('.cover-detail img');
  await expect(cover).toBeVisible();
  await expect
    .poll(() => cover.evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  expect(
    await cover.evaluate((element) => {
      const image = element as HTMLImageElement;
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const pixel = context.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
      return [...pixel.slice(0, 3)].some((channel) => channel < 220);
    }),
  ).toBe(true);
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  const painted = page.locator('.pdf-scroll canvas[data-render-state="ready"]');
  await expect(painted).toHaveAttribute('aria-label', 'Page 1 of 3');
  expect(
    await painted.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const pixel = canvas
        .getContext('2d')!
        .getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
      return (
        canvas.width * canvas.height <= 4_000_000 &&
        [...pixel.slice(0, 3)].some((channel) => channel < 220)
      );
    }),
  ).toBe(true);
  await expect(page.getByText(/Could not open book/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(painted).toHaveAttribute('aria-label', 'Page 2 of 3');
  await expect.poll(async () => (await position(page)).locatorValue).toMatch(/^1:/);
  await page.reload();
  await expect(painted).toHaveAttribute('aria-label', 'Page 2 of 3');
});

test('a source image above the finite limit reports a useful error without deleting the original', async ({
  page,
}) => {
  const bytes = buildImageHeavyPdfFixture(1, {
    imageWidth: 8,
    imageHeight: 8,
    declaredImageWidth: 8000,
    declaredImageHeight: 6000,
  });
  await importStoredBook(page, bytes, 'oversized-source.pdf', 'oversized-source');
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(page.getByText(/Could not open book:.*40 million pixel safety limit/)).toBeVisible();
  await expect(page.locator('.pdf-scroll canvas[data-render-state="ready"]')).toHaveCount(0);
  await page.getByRole('link', { name: '← Close reader' }).click();
  await expect(page.getByRole('button', { name: 'Save original file' })).toBeEnabled();
});
