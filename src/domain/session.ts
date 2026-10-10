import { clampFraction } from './locator';

/**
 * One append-only reading-activity fact (DATA-MODEL.md §7). Sessions are never
 * mutated after they are recorded; statistics are derived from them and are not
 * separately synchronized aggregates.
 */
export interface ReadingSession {
  readonly id: string;
  readonly bookId: string;
  readonly startedAt: number;
  readonly durationS: number;
  readonly startFraction?: number;
  readonly endFraction?: number;
  readonly deviceId: string;
}

/** A session longer than this is almost certainly a device left open; capped. */
export const MAX_SESSION_DURATION_S = 24 * 60 * 60;

export interface NewReadingSession {
  readonly bookId: string;
  readonly startedAt: number;
  readonly durationS: number;
  readonly startFraction?: number;
  readonly endFraction?: number;
}

/** Validates and normalizes a session; clamps implausible durations/fractions. */
export function normalizeSession(input: NewReadingSession): NewReadingSession {
  if (input.bookId.trim().length === 0) {
    throw new Error('A reading session must reference a book.');
  }
  if (!Number.isFinite(input.startedAt) || input.startedAt < 0) {
    throw new Error('A reading session must have a valid start time.');
  }
  if (!Number.isFinite(input.durationS) || input.durationS < 0) {
    throw new Error('A reading session duration must be a non-negative number of seconds.');
  }
  return {
    bookId: input.bookId,
    startedAt: Math.floor(input.startedAt),
    durationS: Math.min(Math.floor(input.durationS), MAX_SESSION_DURATION_S),
    startFraction:
      input.startFraction === undefined ? undefined : clampFraction(input.startFraction),
    endFraction: input.endFraction === undefined ? undefined : clampFraction(input.endFraction),
  };
}

export interface ReadingStats {
  readonly totalSeconds: number;
  readonly sessionCount: number;
  readonly booksRead: number;
  /** Seconds read per book id. */
  readonly perBook: ReadonlyMap<string, number>;
}

/** Derives aggregate statistics from append-only sessions. */
export function summarizeSessions(sessions: readonly ReadingSession[]): ReadingStats {
  const perBook = new Map<string, number>();
  let totalSeconds = 0;
  for (const session of sessions) {
    totalSeconds += session.durationS;
    perBook.set(session.bookId, (perBook.get(session.bookId) ?? 0) + session.durationS);
  }
  return {
    totalSeconds,
    sessionCount: sessions.length,
    booksRead: perBook.size,
    perBook,
  };
}
