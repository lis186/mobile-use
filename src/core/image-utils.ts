/**
 * Shared image optimization for the vision-model pipeline.
 * Half-width + JPEG 80 — used by both run-mode and audit-mode agents,
 * and the live viewer. Centralised so the strategy stays in sync.
 */

import sharp from 'sharp';

/** Resize to ~1/2 width and compress to JPEG quality 80. */
export async function optimizeScreenshot(buffer: Buffer): Promise<Buffer> {
  const metadata = await sharp(buffer).metadata();
  const targetWidth = Math.max(1, Math.round((metadata.width ?? 0) / 2));
  return sharp(buffer).resize(targetWidth).jpeg({ quality: 80 }).toBuffer();
}
