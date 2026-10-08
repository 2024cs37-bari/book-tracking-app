import { READING_STATUS_LABELS, type ReadingStatus } from './enums';
import type { Locator } from './locator';

/**
 * Reading state for one book on all devices. `locator` is null until the
 * reader reports a first position, so imported-but-unread books can still
 * carry a status.
 */
export interface Progress {
  readonly bookId: string;
  readonly status: ReadingStatus;
  readonly locator: Locator | null;
  readonly updatedHlc: string;
  readonly deviceId: string;
}

export const DEFAULT_READING_STATUS: ReadingStatus = 'to_read';

export function progressFraction(progress: Progress | undefined): number {
  if (!progress?.locator) return 0;
  return progress.locator.fraction;
}

export function statusLabel(status: ReadingStatus): string {
  return READING_STATUS_LABELS[status];
}

/**
 * Suggests a status from position: reaching the end marks a book finished,
 * any movement marks it reading. Only used as a default; explicit user choices
 * always win.
 */
export function suggestStatus(fraction: number, current: ReadingStatus): ReadingStatus {
  if (current === 'finished' || current === 'abandoned') return current;
  if (fraction >= 0.995) return 'finished';
  if (fraction > 0) return 'reading';
  return current;
}
