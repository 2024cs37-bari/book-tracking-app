import { expect, type Page } from '@playwright/test';

export async function importBook(
  page: Page,
  bytes: Uint8Array<ArrayBuffer>,
  filename: string,
  title: string,
): Promise<void> {
  await page.goto('/');
  await page.locator('.app-nav').waitFor();
  await page.evaluate(
    ({ base64, filename }) => {
      const transfer = new DataTransfer();
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      transfer.items.add(new File([bytes], filename));
      const input = document.querySelector<HTMLInputElement>('#library-import')!;
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { base64: Buffer.from(bytes).toString('base64'), filename },
  );
  await page
    .getByRole('link', { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
    .click();
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
}

export async function position(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('book-reader');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<
      { locatorKind?: string; locatorValue?: string; fraction: number }[]
    >((resolve, reject) => {
      const request = db.transaction('progress').objectStore('progress').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return rows[0]!;
  });
}
