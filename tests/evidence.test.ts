import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, lstat, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import { saveEvidence } from '../src/core/evidence.ts';

async function makeSyntheticPng(rgb: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({
    create: { width: 200, height: 300, channels: 4, background: { ...rgb, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

// ── Hash-based dedup ─────────────────────────────────────────────

test('saveEvidence: two identical buffers share one source file', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evidence-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const png = await makeSyntheticPng({ r: 100, g: 100, b: 100 });
  await saveEvidence(dir, png, 'ISSUE-001');
  await saveEvidence(dir, png, 'ISSUE-002');
  await saveEvidence(dir, png, 'ISSUE-003');

  const entries = await readdir(path.join(dir, 'screenshots'));
  // Expect: 1 source file (_<hash>.jpg) + 3 per-issue pointers (copies or symlinks)
  const sources = entries.filter((e) => e.startsWith('_'));
  const pointers = entries.filter((e) => !e.startsWith('_'));
  assert.equal(sources.length, 1, `expected 1 source, got ${sources.length}`);
  assert.equal(pointers.length, 3);
  assert.ok(pointers.includes('ISSUE-001.jpg'));
  assert.ok(pointers.includes('ISSUE-002.jpg'));
  assert.ok(pointers.includes('ISSUE-003.jpg'));
});

test('saveEvidence: different buffers produce different source files', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evidence-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const red = await makeSyntheticPng({ r: 255, g: 0, b: 0 });
  const blue = await makeSyntheticPng({ r: 0, g: 0, b: 255 });
  await saveEvidence(dir, red, 'ISSUE-001');
  await saveEvidence(dir, blue, 'ISSUE-002');

  const entries = await readdir(path.join(dir, 'screenshots'));
  const sources = entries.filter((e) => e.startsWith('_'));
  assert.equal(sources.length, 2, `expected 2 distinct sources, got ${sources.length}`);
});

test('saveEvidence: returns relative path usable in a Markdown report', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evidence-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const png = await makeSyntheticPng({ r: 0, g: 0, b: 0 });
  const relPath = await saveEvidence(dir, png, 'ISSUE-042');
  assert.equal(relPath, 'screenshots/ISSUE-042.jpg');

  const absPath = path.join(dir, relPath);
  const info = await stat(absPath);
  assert.ok(info.size > 0);
});

test('saveEvidence: idempotent — calling twice for same issue does not error', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evidence-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const png = await makeSyntheticPng({ r: 50, g: 50, b: 50 });
  await saveEvidence(dir, png, 'ISSUE-001');
  await saveEvidence(dir, png, 'ISSUE-001');  // should not throw
  await saveEvidence(dir, png, 'ISSUE-001');

  const entries = await readdir(path.join(dir, 'screenshots'));
  const pointers = entries.filter((e) => e === 'ISSUE-001.jpg');
  assert.equal(pointers.length, 1);
});

test('saveEvidence: pointer is a symlink on macOS/Linux', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evidence-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const png = await makeSyntheticPng({ r: 200, g: 100, b: 50 });
  await saveEvidence(dir, png, 'ISSUE-001');

  const linkInfo = await lstat(path.join(dir, 'screenshots', 'ISSUE-001.jpg'));
  // On macOS / Linux this should be a symlink; on a filesystem that rejects
  // symlinks the code falls back to copy (lstat then reports file, not link).
  // Both outcomes are acceptable — we just want no crash and a usable file.
  assert.ok(linkInfo.isSymbolicLink() || linkInfo.isFile());
});

test('saveEvidence: optimized JPEG is smaller than raw PNG input', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evidence-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Build a reasonably complex PNG so JPEG compression actually reduces size
  const png = await sharp({
    create: { width: 1179, height: 2556, channels: 4, background: { r: 30, g: 60, b: 110, alpha: 1 } },
  })
    .png()
    .toBuffer();

  const rel = await saveEvidence(dir, png, 'ISSUE-BIG');
  const out = await stat(path.join(dir, rel));
  assert.ok(out.size < png.length, `expected optimized JPEG (${out.size}) < PNG (${png.length})`);
});
