import { PNG } from "pngjs";

/** RGBA colour of one pixel. */
export type Pixel = [number, number, number, number];

/**
 * A PNG built from literal pixel data. `pixel(x, y)` gives each pixel (default: opaque orange). With `alpha: false` the
 * file has no alpha channel (colour type 2).
 */
export function makePng(width: number, height: number, opts: { pixel?: (x: number, y: number) => Pixel; alpha?: boolean } = {}): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = opts.pixel?.(x, y) ?? [255, 140, 36, 255];
      png.data.set([r, g, b, a], (y * width + x) * 4);
    }
  }
  return opts.alpha === false ? PNG.sync.write(png, { colorType: 2, inputHasAlpha: true }) : PNG.sync.write(png, { colorType: 6 });
}
