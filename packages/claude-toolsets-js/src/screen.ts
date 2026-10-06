/** Above this many pixels the API shrinks a screenshot, and the model's click coordinates no longer match the screen. */
export const MAX_SCREEN_PIXELS = 2560 * 1440;

/** Refuse a screen or viewport the model cannot click on accurately. */
export function checkScreen(what: string, width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 200 || height < 200)
    throw new Error(`${what}: width and height must be integers of at least 200`);
  if (width * height > MAX_SCREEN_PIXELS)
    throw new Error(
      `${what} ${width}x${height} is too large: the API shrinks larger screenshots and clicks miss; use at most 2560x1440 pixels in total, e.g. 1920x1200`,
    );
}

/** The width and height in a PNG's header. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
