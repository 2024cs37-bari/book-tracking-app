import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TestInfo } from '@playwright/test';

/** Persist JSON on disk so CI can retain it even with the default text reporter. */
export async function attachEvidence(info: TestInfo, name: string, value: unknown): Promise<void> {
  const path = info.outputPath('attachments', `${name}.json`);
  await mkdir(dirname(path), { recursive: true });
  const body = JSON.stringify(value, null, 2);
  await writeFile(path, body);
  await info.attach(name, { body, contentType: 'application/json' });
}
