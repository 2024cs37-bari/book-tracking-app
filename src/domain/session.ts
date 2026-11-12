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
  if (
    !Number.isFinite(input.startedAt) ||
    input.startedAt < 0 ||
    input.startedAt > 8_640_000_000_000_000 - 86_400_000
  ) {
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
  readonly readingDays: number;
  readonly currentStreak: number;
  readonly longestStreak: number;
  /** Calendar days in this device's timezone; session time is split at midnight. */
  readonly perDay: ReadonlyMap<string, number>;
  /** Last recorded position per book on a session's ending day; never summed across books. */
  readonly perDayProgress: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

/** Derives aggregate statistics from append-only sessions. */
export function summarizeSessions(
  sessions: readonly ReadingSession[],
  now = Date.now(),
): ReadingStats {
  const perBook = new Map<string, number>();
  const daySeconds = new Map<number, number>();
  const dayPositions = new Map<number, Map<string, { at: number; id: string; fraction: number }>>();
  let totalSeconds = 0;
  for (const session of sessions) {
    totalSeconds += session.durationS;
    perBook.set(session.bookId, (perBook.get(session.bookId) ?? 0) + session.durationS);
    let cursor = session.startedAt;
    let remaining = Math.min(MAX_SESSION_DURATION_S, Math.max(0, session.durationS)) * 1000;
    if (!Number.isFinite(remaining) || !Number.isFinite(cursor)) continue;
    if (
      remaining > 0 &&
      session.endFraction !== undefined &&
      Number.isFinite(session.endFraction)
    ) {
      // An interval ending exactly at midnight belongs to the preceding reading day.
      // Keep one final observed position, not a sum that turns rereading/seeking into progress.
      const endedAt = cursor + remaining;
      const finalDay = calendarDay(endedAt - 1);
      if (Number.isFinite(finalDay)) {
        const positions = dayPositions.get(finalDay) ?? new Map();
        const previous = positions.get(session.bookId);
        if (
          !previous ||
          endedAt > previous.at ||
          (endedAt === previous.at && session.id > previous.id)
        ) {
          positions.set(session.bookId, {
            at: endedAt,
            id: session.id,
            fraction: clampFraction(session.endFraction),
          });
        }
        dayPositions.set(finalDay, positions);
      }
    }
    while (remaining > 0) {
      const date = new Date(cursor);
      const nextMidnight = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate() + 1,
      ).getTime();
      if (!Number.isFinite(nextMidnight) || nextMidnight <= cursor) break;
      const portion = Math.min(remaining, nextMidnight - cursor);
      const day = calendarDay(cursor);
      daySeconds.set(day, (daySeconds.get(day) ?? 0) + portion / 1000);
      cursor += portion;
      remaining -= portion;
    }
  }
  const days = [...daySeconds.keys()].sort((a, b) => a - b);
  let longestStreak = 0;
  let run = 0;
  let previous: number | undefined;
  for (const day of days) {
    run = previous !== undefined && day === previous + 1 ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    previous = day;
  }
  const today = calendarDay(now);
  let day = daySeconds.has(today) ? today : today - 1;
  let currentStreak = 0;
  while (daySeconds.has(day)) {
    currentStreak++;
    day--;
  }
  return {
    totalSeconds,
    sessionCount: sessions.length,
    booksRead: perBook.size,
    perBook,
    readingDays: days.length,
    currentStreak,
    longestStreak,
    perDay: new Map(
      days.map((day) => [
        new Date(day * 86_400_000).toISOString().slice(0, 10),
        daySeconds.get(day)!,
      ]),
    ),
    perDayProgress: new Map(
      days.map((day) => [
        new Date(day * 86_400_000).toISOString().slice(0, 10),
        new Map(
          [...(dayPositions.get(day) ?? [])]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([bookId, position]) => [bookId, position.fraction]),
        ),
      ]),
    ),
  };
}

function calendarDay(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}
