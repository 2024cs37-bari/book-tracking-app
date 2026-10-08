import { expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { observePdfStreamErrors } from '~/reader/pdf-stream-errors';

it('reports an operator stream error before passing the rejection to the SDK reader', async () => {
  const failure = new Error('Image exceeded maximum allowed size');
  const handler = {
    sendWithStream: (_action: string, _data: { pageIndex: number }) =>
      new ReadableStream({
        pull(controller) {
          controller.error(failure);
        },
      }),
  };
  const onError = vi.fn();
  const capture = vi.fn(() => onError);
  observePdfStreamErrors(
    { _transport: { messageHandler: handler } } as unknown as PDFDocumentProxy,
    capture,
  );
  const reader = handler.sendWithStream('GetOperatorList', { pageIndex: 4 }).getReader();
  await expect(reader.read()).rejects.toBe(failure);
  expect(capture).toHaveBeenCalledWith(4);
  expect(onError).toHaveBeenCalledWith(failure);
});

it('leaves unrelated streams untouched and rejects unsupported SDK shapes explicitly', () => {
  const stream = new ReadableStream();
  const handler = { sendWithStream: (_action: string, _data: { pageIndex: number }) => stream };
  const capture = vi.fn();
  observePdfStreamErrors(
    { _transport: { messageHandler: handler } } as unknown as PDFDocumentProxy,
    capture,
  );
  expect(handler.sendWithStream('GetTextContent', { pageIndex: 1 })).toBe(stream);
  expect(capture).not.toHaveBeenCalled();
  expect(() => observePdfStreamErrors({} as PDFDocumentProxy, capture)).toThrow(
    'compatibility hook unavailable',
  );
});

it('forwards cancellation without reporting it as an operator-list failure', async () => {
  const cancel = vi.fn();
  const source = new ReadableStream({ cancel });
  const handler = { sendWithStream: (_action: string, _data: { pageIndex: number }) => source };
  const onError = vi.fn();
  observePdfStreamErrors(
    { _transport: { messageHandler: handler } } as unknown as PDFDocumentProxy,
    () => onError,
  );
  const reader = handler.sendWithStream('GetOperatorList', { pageIndex: 0 }).getReader();
  const pending = reader.read();
  await reader.cancel('navigation');
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(cancel).toHaveBeenCalledWith('navigation');
  expect(onError).not.toHaveBeenCalled();
});
