import { expect, it, vi } from 'vitest';
import { invertPdfCanvas, PDF_COLOR_CHUNK_PIXELS } from '~/reader/pdf-colors';

it('inverts luminance, preserves colour direction and leaves alpha unchanged', () => {
  const data = new Uint8ClampedArray([
    255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 255,
  ]);
  const putImageData = vi.fn();
  const canvas = {
    width: 5,
    height: 1,
    getContext: () => ({ getImageData: () => ({ data }), putImageData }),
  } as unknown as HTMLCanvasElement;
  invertPdfCanvas(canvas);
  expect([...data]).toEqual([
    0, 0, 0, 255, 255, 255, 255, 255, 255, 146, 146, 128, 0, 145, 0, 255, 218, 218, 255, 255,
  ]);
  expect(putImageData).toHaveBeenCalledOnce();
});

it('processes the entire bounded raster in strips without allocating a full-page copy', () => {
  const reads: number[][] = [];
  const writes: number[] = [];
  const canvas = {
    width: 16_384,
    height: 19,
    getContext: () => ({
      getImageData: (x: number, y: number, width: number, height: number) => {
        reads.push([x, y, width, height]);
        return { data: new Uint8ClampedArray(width * height * 4) };
      },
      putImageData: (_data: unknown, _x: number, y: number) => writes.push(y),
    }),
  } as unknown as HTMLCanvasElement;
  invertPdfCanvas(canvas);
  expect(reads.map(([, y, , height]) => [y, height])).toEqual([
    [0, 4],
    [4, 4],
    [8, 4],
    [12, 4],
    [16, 3],
  ]);
  expect(reads.every(([, , width, height]) => width! * height! <= PDF_COLOR_CHUNK_PIXELS)).toBe(
    true,
  );
  expect(writes).toEqual([0, 4, 8, 12, 16]);
});
