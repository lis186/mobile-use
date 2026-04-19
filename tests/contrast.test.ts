import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { wcagContrast, sampleContrast } from '../src/core/contrast.ts';

// ── Pure math ─────────────────────────────────────────────────

test('wcagContrast: black vs white = 21', () => {
  assert.strictEqual(wcagContrast(0, 1), 21);
});

test('wcagContrast: same luminance = 1', () => {
  assert.strictEqual(wcagContrast(0.5, 0.5), 1);
});

test('wcagContrast: symmetric (arg order does not matter)', () => {
  assert.strictEqual(wcagContrast(0.2, 0.8), wcagContrast(0.8, 0.2));
});

test('wcagContrast: mid-grey vs white ≈ 3.95:1', () => {
  // L(#777777) ≈ 0.2158
  const grey = 0.2158;
  const ratio = wcagContrast(grey, 1);
  assert.ok(ratio > 3 && ratio < 5, `expected ~3.95, got ${ratio}`);
});

// ── Pixel sampling ────────────────────────────────────────────

async function solidImage(r: number, g: number, b: number, size = 40): Promise<Buffer> {
  return sharp({
    create: { width: size, height: size, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
}

async function halfImage(): Promise<Buffer> {
  // Top half: white (255,255,255), bottom half: black (0,0,0)
  const row = 40;
  const white = Buffer.alloc(row * 3, 255);
  const black = Buffer.alloc(row * 3, 0);
  const raw = Buffer.concat([...Array(row).fill(white), ...Array(row).fill(black)]);
  return sharp(raw, { raw: { width: row, height: row * 2, channels: 3 } })
    .png()
    .toBuffer();
}

test('sampleContrast: returns null for a corrupt buffer', async () => {
  const result = await sampleContrast(Buffer.from('not-an-image'), 50, 50);
  assert.strictEqual(result, null);
});

test('sampleContrast: solid white image → contrast = 1', async () => {
  const buf = await solidImage(255, 255, 255);
  const ratio = await sampleContrast(buf, 50, 50);
  assert.strictEqual(ratio, 1);
});

test('sampleContrast: half white / half black → high contrast', async () => {
  const buf = await halfImage();
  const ratio = await sampleContrast(buf, 50, 50); // centre = boundary
  assert.ok(ratio !== null && ratio > 5, `expected high contrast, got ${ratio}`);
});

test('sampleContrast: coordinates outside image still return a result (clamped)', async () => {
  const buf = await solidImage(128, 128, 128);
  // coordinates at the very edge — should clamp rather than throw
  const result = await sampleContrast(buf, 99, 99);
  assert.ok(result !== null);
});
