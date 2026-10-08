import type { PDFDocumentProxy } from 'pdfjs-dist';

interface OperatorRequest {
  pageIndex: number;
}
interface StreamHandler {
  sendWithStream(
    action: string,
    data: OperatorRequest,
    ...rest: unknown[]
  ): ReadableStream<unknown>;
}

/**
 * pdf.js 5.4.624 completes a partial operator list before rejecting its stream
 * error capability. RenderTask.promise can therefore resolve for a blank page,
 * even with stopAtErrors. Intercept only this document's operator-list streams
 * before the display layer receives the rejection. No global SDK patching.
 * This private bridge is version-sensitive and covered by oversized-image corpus tests.
 */
export function observePdfStreamErrors(
  pdf: PDFDocumentProxy,
  capture: (pageIndex: number) => (error: unknown) => void,
): void {
  const handler = (pdf as unknown as { _transport?: { messageHandler?: StreamHandler } })._transport
    ?.messageHandler;
  if (!handler?.sendWithStream)
    throw new Error('PDF.js operator-stream compatibility hook unavailable.');
  const original = handler.sendWithStream.bind(handler);
  handler.sendWithStream = (action, data, ...rest) => {
    const source = original(action, data, ...rest);
    if (action !== 'GetOperatorList') return source;
    const onError = capture(data.pageIndex);
    const reader = source.getReader();
    let canceled = false;
    return new ReadableStream({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (canceled) return;
          if (result.done) controller.close();
          else controller.enqueue(result.value);
        } catch (error) {
          if (canceled) return;
          onError(error);
          controller.error(error);
        }
      },
      cancel(reason) {
        canceled = true;
        return reader.cancel(reason);
      },
    });
  };
}
