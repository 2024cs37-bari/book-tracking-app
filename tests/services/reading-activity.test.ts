import { expect, it, vi } from 'vitest';
import type { NewReadingSession } from '~/domain/session';
import { ReadingActivity, ReadingActivityQueue } from '~/services/reading-activity';

it('counts separate foreground spans, excludes hidden time, and makes repeated pause idempotent', async () => {
  let wall = 1_700_000_000_000;
  let elapsed = 0;
  const record = vi.fn(async (_span: NewReadingSession) => {});
  const queue = new ReadingActivityQueue(record, async () => {});
  const activity = new ReadingActivity(
    'canonical-book',
    queue,
    vi.fn(),
    () => wall,
    () => elapsed,
  );
  activity.resume(0.1);
  elapsed += 10_000;
  wall += 10_000;
  await activity.pause(0.2);
  await activity.pause(0.2);
  elapsed += 50_000;
  wall += 50_000;
  activity.resume(0.2);
  elapsed += 20_000;
  wall += 20_000;
  await activity.pause(0.4);
  expect(record.mock.calls).toEqual([
    [
      {
        bookId: 'canonical-book',
        startedAt: 1_700_000_000_000,
        durationS: 10,
        startFraction: 0.1,
        endFraction: 0.2,
      },
    ],
    [
      {
        bookId: 'canonical-book',
        startedAt: 1_700_000_060_000,
        durationS: 20,
        startFraction: 0.2,
        endFraction: 0.4,
      },
    ],
  ]);
});

it('checkpoints continue the current span and use monotonic duration despite a wall clock jump', async () => {
  let wall = 1_700_000_000_000;
  let elapsed = 0;
  const record = vi.fn(async (_span: NewReadingSession) => {});
  const activity = new ReadingActivity(
    'book',
    new ReadingActivityQueue(record, async () => {}),
    vi.fn(),
    () => wall,
    () => elapsed,
  );
  activity.resume(0);
  elapsed += 60_000;
  wall -= 3_600_000;
  await activity.checkpoint(0.4);
  elapsed += 30_000;
  await activity.pause(0.6);
  expect(
    record.mock.calls.map((call) => (call[0] as unknown as { durationS: number }).durationS),
  ).toEqual([60, 30]);
});

it('retains a failed span for retry without counting it twice', async () => {
  let now = 0;
  const record = vi
    .fn(async (_span: NewReadingSession) => {})
    .mockRejectedValueOnce(new Error('quota'));
  const report = vi.fn();
  const activity = new ReadingActivity(
    'book',
    new ReadingActivityQueue(record, async () => {}),
    report,
    () => now,
    () => now,
  );
  activity.resume(0);
  now += 10_000;
  await activity.pause(0.2);
  await activity.retry();
  expect(record).toHaveBeenCalledTimes(2);
  expect(record.mock.calls[0]).toEqual(record.mock.calls[1]);
  await activity.pause(0.2);
  expect(record).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenLastCalledWith(null);
});

it('does not duplicate committed session facts when clock persistence fails', async () => {
  const record = vi.fn(async (_span: NewReadingSession) => {});
  const clock = vi.fn(async () => {}).mockRejectedValueOnce(new Error('clock unavailable'));
  const queue = new ReadingActivityQueue(record, clock);
  queue.enqueue({ bookId: 'book', startedAt: 1000, durationS: 20 });
  await queue.flush(vi.fn());
  await queue.flush(vi.fn());
  expect(record).toHaveBeenCalledOnce();
  expect(clock).toHaveBeenCalledTimes(2);
});
