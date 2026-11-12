import { afterEach, expect, it, vi } from 'vitest';
import { createNativeCloseHandler } from '~/app/native-lifecycle';

afterEach(() => vi.useRealTimers());

it('waits for every local write before closing and coalesces repeated close requests', async () => {
  let finish!: (saved: boolean) => void;
  const guard = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const close = vi.fn(async () => {});
  const confirm = vi.fn(() => true);
  const event = { preventDefault: vi.fn() };
  const handler = createNativeCloseHandler({ guards: () => [guard], close, confirm });
  const pending = handler(event);
  await handler(event);
  expect(guard).toHaveBeenCalledOnce();
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  expect(close).not.toHaveBeenCalled();
  finish(true);
  await pending;
  expect(close).toHaveBeenCalledOnce();
  expect(confirm).not.toHaveBeenCalled();
});

it('allows a user to retain the open app when a durable write failed', async () => {
  const close = vi.fn(async () => {});
  const confirm = vi.fn(() => false);
  const handler = createNativeCloseHandler({ guards: () => [async () => false], close, confirm });
  await handler({ preventDefault() {} });
  expect(confirm).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
});

it('requires a concrete close-anyway choice on thrown writes or timeout', async () => {
  vi.useFakeTimers();
  const close = vi.fn(async () => {});
  const confirm = vi.fn(() => true);
  const handler = createNativeCloseHandler({
    guards: () => [() => new Promise(() => {})],
    close,
    confirm,
    timeoutMs: 100,
  });
  const pending = handler({ preventDefault() {} });
  await vi.advanceTimersByTimeAsync(99);
  expect(close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(confirm).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  const failed = createNativeCloseHandler({
    guards: () => [
      async () => {
        throw new Error('storage failure');
      },
    ],
    close,
    confirm,
  });
  await failed({ preventDefault() {} });
  expect(confirm).toHaveBeenCalledTimes(2);
});
