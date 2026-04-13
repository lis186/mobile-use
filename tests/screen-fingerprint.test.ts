import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  fingerprintScreen,
  fingerprintFromLabels,
  fingerprintFromScreenshot,
} from '../src/core/screen-fingerprint.ts';
import type { ParsedTree } from '../src/core/tree-parser.ts';

// ── fingerprintFromLabels (rich path) ────────────────────────────

test('fingerprintFromLabels: same input yields identical fingerprint', () => {
  const tree = '[Button] "Submit"\n[Text] "Welcome"\n[Cell] "Settings"';
  assert.equal(fingerprintFromLabels(tree), fingerprintFromLabels(tree));
});

test('fingerprintFromLabels: label order does not matter (sort invariance)', () => {
  const a = '[Button] "A"\n[Button] "B"\n[Button] "C"';
  const b = '[Button] "C"\n[Button] "A"\n[Button] "B"';
  assert.equal(fingerprintFromLabels(a), fingerprintFromLabels(b));
});

test('fingerprintFromLabels: different labels → different fingerprints', () => {
  const a = '[Button] "Home"\n[Button] "Settings"';
  const b = '[Button] "Home"\n[Button] "Profile"';
  assert.notEqual(fingerprintFromLabels(a), fingerprintFromLabels(b));
});

test('fingerprintFromLabels: returns 8-char hex string', () => {
  const fp = fingerprintFromLabels('[Button] "test"');
  assert.equal(fp.length, 8);
  assert.match(fp, /^[0-9a-f]{8}$/);
});

test('fingerprintFromLabels: empty tree returns deterministic value', () => {
  const fp = fingerprintFromLabels('');
  assert.equal(fp.length, 8);
  assert.equal(fp, fingerprintFromLabels(''));
});

// ── fingerprintFromScreenshot (sparse/empty path) ────────────────

test('fingerprintFromScreenshot: same buffer yields identical fingerprint', async () => {
  const img = await sharp({
    create: { width: 100, height: 100, channels: 4, background: { r: 50, g: 100, b: 150, alpha: 1 } },
  }).png().toBuffer();
  const b64 = img.toString('base64');
  const a = await fingerprintFromScreenshot(b64);
  const b = await fingerprintFromScreenshot(b64);
  assert.equal(a, b);
  assert.equal(a.length, 8);
});

test('fingerprintFromScreenshot: different patterns → different fingerprints', async () => {
  // Use distinct spatial patterns; solid colors all collapse to the same
  // 8x8 greyscale signature and would produce identical aHash values.
  // Left-half-dark vs right-half-dark is enough spatial contrast to differ.
  const leftDark = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="64" height="64"><rect x="0" y="0" width="32" height="64" fill="black"/></svg>',
        ),
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();

  const topDark = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="64" height="64"><rect x="0" y="0" width="64" height="32" fill="black"/></svg>',
        ),
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();

  const a = await fingerprintFromScreenshot(leftDark.toString('base64'));
  const b = await fingerprintFromScreenshot(topDark.toString('base64'));
  assert.notEqual(a, b);
});

test('fingerprintFromScreenshot: empty buffer returns fallback (no throw)', async () => {
  const fp = await fingerprintFromScreenshot('');
  assert.equal(fp, '00000000');
});

test('fingerprintFromScreenshot: malformed base64 returns fallback (no throw)', async () => {
  const fp = await fingerprintFromScreenshot('not-valid-base64-image-data');
  assert.equal(fp.length, 8);
});

// ── fingerprintScreen (dispatch) ─────────────────────────────────

test('fingerprintScreen: rich grade dispatches to label path', async () => {
  const parsed: ParsedTree = {
    text: '[Button] "Home"\n[Button] "Settings"',
    grade: 'rich',
    labeledElementCount: 2,
  };
  const fp = await fingerprintScreen({ parsed, grade: 'rich' });
  assert.equal(fp, fingerprintFromLabels(parsed.text));
});

test('fingerprintScreen: empty grade with screenshot falls back to perceptual hash', async () => {
  const img = await sharp({
    create: { width: 50, height: 50, channels: 4, background: { r: 100, g: 100, b: 100, alpha: 1 } },
  }).png().toBuffer();
  const fp = await fingerprintScreen({
    screenshotBase64: img.toString('base64'),
    grade: 'empty',
  });
  assert.equal(fp.length, 8);
  assert.match(fp, /^[0-9a-f]{8}$/);
});

test('fingerprintScreen: no usable input returns deterministic fallback', async () => {
  const fp = await fingerprintScreen({ grade: 'empty' });
  assert.equal(fp, '00000000');
});
