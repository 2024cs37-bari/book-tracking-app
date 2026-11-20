import { expect, type Locator, type Page } from '@playwright/test';

/** Choose through the same custom popup and pointer path used by a reader. */
export async function chooseSelect(
  control: Locator,
  choice: string | { label: string },
): Promise<void> {
  await expect(control).toHaveAttribute('role', 'combobox');
  if ((await control.getAttribute('aria-expanded')) !== 'true') await control.click();
  const popupId = await control.getAttribute('aria-controls');
  expect(popupId).toBeTruthy();
  const escapedId = await control.evaluate((_, value) => CSS.escape(value), popupId!);
  const listbox = control.page().locator(`#${escapedId}`);
  await expect(listbox).toHaveAttribute('role', 'listbox');
  await expect(listbox).toBeVisible();
  const option =
    typeof choice === 'string'
      ? listbox.locator(
          `[role="option"][data-value="${await control.evaluate((_, value) => CSS.escape(value), choice)}"]`,
        )
      : listbox.getByRole('option', { name: choice.label, exact: true });
  const selectedValue = await option.getAttribute('data-value');
  expect(selectedValue).not.toBeNull();
  await option.click();
  await expect(control).toHaveAttribute('aria-expanded', 'false');
  await expect(control).toHaveAttribute('data-value', selectedValue!);
}

export async function importStoredBook(
  page: Page,
  bytes: Uint8Array<ArrayBuffer>,
  filename: string,
  title: string,
): Promise<void> {
  await page.goto('/');
  await page.locator('.app-header').waitFor();
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
}

export async function importBook(
  page: Page,
  bytes: Uint8Array<ArrayBuffer>,
  filename: string,
  title: string,
): Promise<void> {
  await importStoredBook(page, bytes, filename, title);
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
