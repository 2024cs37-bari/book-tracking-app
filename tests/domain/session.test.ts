import { expect, it } from 'vitest';
import { normalizeSession, summarizeSessions, type ReadingSession } from '~/domain/session';

const at = (day: number, hour = 12, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const session = (id: string, day: number, durationS = 60): ReadingSession => ({
  id,
  bookId: 'book',
  deviceId: 'device',
  startedAt: at(day),
  durationS,
});

it('streaks remain active through today and break after a missed day', () => {
  const rows = [session('1', 1), session('2', 2), session('3', 4), session('4', 5)];
  const stats = summarizeSessions(rows, at(6));
  expect(stats.readingDays).toBe(4);
  expect(stats.currentStreak).toBe(2);
  expect(stats.longestStreak).toBe(2);
  expect(summarizeSessions(rows, at(7)).currentStreak).toBe(0);
});

it('splits time crossing local midnight between calendar days', () => {
  const stats = summarizeSessions(
    [{ ...session('overnight', 1, 120), startedAt: at(1, 23, 59) }],
    at(2),
  );
  expect(stats.perDay.get('2026-11-01')).toBe(60);
  expect(stats.perDay.get('2026-11-02')).toBe(60);
  expect(stats.totalSeconds).toBe(120);
  expect(stats.currentStreak).toBe(2);
});

it('zero-length sessions do not invent a reading day', () => {
  const stats = summarizeSessions([session('zero', 1, 0)], at(1));
  expect(stats.readingDays).toBe(0);
  expect(stats.currentStreak).toBe(0);
  expect(stats.longestStreak).toBe(0);
});

it('rejects dates outside the calendar range before persisting sessions', () => {
  expect(() => normalizeSession({ bookId: 'book', startedAt: 1e18, durationS: 10 })).toThrow(
    'valid start',
  );
});

it('records each book’s latest daily position, including backward navigation, independent of replay order', () => {
  const rows = [
    { ...session('a', 1), endFraction: 0.8 },
    { ...session('b', 1), startedAt: at(1, 14), endFraction: 0.2 },
    { ...session('c', 1), bookId: 'other', endFraction: 0.5 },
    { ...session('d', 2), endFraction: 0.4 },
  ];
  const stats = summarizeSessions(rows, at(2));
  expect(stats.perDayProgress.get('2026-11-01')).toEqual(
    new Map([
      ['book', 0.2],
      ['other', 0.5],
    ]),
  );
  expect(stats.perDayProgress.get('2026-11-02')?.get('book')).toBe(0.4);
  expect(summarizeSessions([...rows].reverse()).perDayProgress).toEqual(stats.perDayProgress);
});

it('attributes a final position at midnight to the preceding day without inventing missing fractions', () => {
  const stats = summarizeSessions([
    { ...session('a', 1, 60), startedAt: at(1, 23, 59), endFraction: 0.3 },
    { ...session('b', 2, 60) },
    { ...session('zero', 3, 0), endFraction: 0.9 },
  ]);
  expect(stats.perDayProgress.get('2026-11-01')?.get('book')).toBe(0.3);
  expect(stats.perDayProgress.get('2026-11-02')?.size).toBe(0);
  expect(stats.perDayProgress.has('2026-11-03')).toBe(false);
});
