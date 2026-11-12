/** At most 256 KiB of temporary RGBA data, independent of the CSS zoom. */
export const PDF_COLOR_CHUNK_PIXELS = 65_536;

/**
 * Match invert(1) hue-rotate(180deg) on the bounded raster, before display.
 * A live CSS filter can allocate compositor surfaces at the much larger CSS
 * page size and crash the browser graphics process. Never filter the DOM canvas.
 * Turning inversion off must render the original PDF again: clipped colour
 * channels make this transform lossy, so applying it twice is not an undo.
 */
export function invertPdfCanvas(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Page colours could not be rendered.');
  const rows = Math.max(1, Math.floor(PDF_COLOR_CHUNK_PIXELS / canvas.width));
  for (let y = 0; y < canvas.height; y += rows) {
    const strip = context.getImageData(0, y, canvas.width, Math.min(rows, canvas.height - y));
    const pixels = strip.data;
    for (let i = 0; i < pixels.length; i += 4) {
      const red = pixels[i]!;
      const green = pixels[i + 1]!;
      const blue = pixels[i + 2]!;
      const shift = 255 - 0.426 * red - 1.43 * green - 0.144 * blue;
      pixels[i] = red + shift;
      pixels[i + 1] = green + shift;
      pixels[i + 2] = blue + shift;
    }
    context.putImageData(strip, 0, y);
  }
}
