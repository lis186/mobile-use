/**
 * Screen fingerprinting for audit-mode exploration deduplication.
 *
 * Rich-tree path: MD5 of sorted labels → stable across identical screens
 * regardless of render order or timing.
 *
 * Sparse/empty path: average-hash (aHash) of the screenshot → tolerates
 * tiny visual differences (battery level, clock) while still distinguishing
 * different screens.
 *
 * Both paths return an 8-character hex string used as a Map key.
 */

import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { TreeQuality } from '../types.js';
import { extractLabels, type ParsedTree } from './tree-parser.js';

export interface FingerprintInput {
  parsed?: ParsedTree;
  screenshotBase64?: string;
  grade: TreeQuality;
}

/**
 * Fingerprint the current screen using the best-available data.
 * Returns an 8-character hex string stable across repeated calls on the
 * same screen.
 */
export async function fingerprintScreen(input: FingerprintInput): Promise<string> {
  if (input.grade === 'rich' && input.parsed) {
    return fingerprintFromLabels(input.parsed.text);
  }
  if (input.screenshotBase64) {
    return fingerprintFromScreenshot(input.screenshotBase64);
  }
  // Last-resort: use whatever tree text exists
  if (input.parsed?.text) {
    return fingerprintFromLabels(input.parsed.text);
  }
  return '00000000';
}

/** MD5-of-sorted-labels fingerprint (rich tree path). */
export function fingerprintFromLabels(parsedText: string): string {
  const labels = extractLabels(parsedText);
  const joined = labels.join('|');
  return createHash('md5').update(joined).digest('hex').slice(0, 8);
}

/**
 * Average-hash perceptual fingerprint (sparse/empty tree path).
 * Shrinks the screenshot to 8×8 greyscale, compares each pixel to the mean,
 * and hashes the resulting bitstring. Two visually similar screens will
 * typically produce identical or very close fingerprints.
 */
export async function fingerprintFromScreenshot(screenshotBase64: string): Promise<string> {
  const buffer = Buffer.from(screenshotBase64, 'base64');
  // Guard before sharp() so an empty buffer doesn't throw and crash the audit loop.
  if (buffer.length === 0) return '00000000';

  let data: Buffer;
  try {
    const result = await sharp(buffer)
      .resize(8, 8, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    data = result.data;
  } catch {
    // Invalid image data — return a stable fallback rather than crashing the audit.
    return '00000000';
  }

  if (data.length === 0) return '00000000';

  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i]!;
  const mean = sum / data.length;

  // Build a 64-bit pattern (MSB first), then hash it so visually similar
  // screens with small mean shifts still collide via the hash.
  let bits = '';
  for (let i = 0; i < data.length; i++) {
    bits += data[i]! >= mean ? '1' : '0';
  }
  return createHash('md5').update(bits).digest('hex').slice(0, 8);
}
