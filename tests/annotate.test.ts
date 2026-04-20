import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import { annotateScreenshot, writeAnnotated } from '../src/core/annotate.ts';
import type { AgentDecision } from '../src/types.ts';

async function makeBlankScreenshot(): Promise<Buffer> {
  return sharp({
    create: { width: 1179, height: 2556, channels: 4, background: { r: 20, g: 40, b: 80, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

const ctx = { stepNumber: 7, totalSteps: 25, model: 'gemini-2.5-flash' };

/** JPEGs start with the magic bytes FF D8 FF */
function isValidJpeg(buf: Buffer): boolean {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

// ── Action-specific markers ──────────────────────────────────────

test('annotate: tap action produces a valid JPEG with red circle', async () => {
  const bg = await makeBlankScreenshot();
  const decision: AgentDecision = {
    action: 'tap',
    params: { x: 85, y: 85 },
    reasoning: 'Tapping the FAB to compose a new message.',
    progress: 30,
  };
  const out = await annotateScreenshot(bg, decision, ctx);
  assert.ok(isValidJpeg(out));
  assert.ok(out.length > 0);

  // Output dimensions should match input
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 1179);
  assert.equal(meta.height, 2556);
});

test('annotate: tapText action (no x/y) still produces a valid JPEG', async () => {
  const bg = await makeBlankScreenshot();
  const decision: AgentDecision = {
    action: 'tapText',
    params: { text: 'Settings' },
    reasoning: 'Opening Settings to explore notification options.',
    progress: 20,
  };
  const out = await annotateScreenshot(bg, decision, ctx);
  assert.ok(isValidJpeg(out));
});

test('annotate: scroll action produces a valid JPEG with arrow marker', async () => {
  const bg = await makeBlankScreenshot();
  const decision: AgentDecision = {
    action: 'scroll',
    params: { startX: 50, startY: 80, endX: 50, endY: 20 },
    reasoning: 'Scrolling down to reveal more list items.',
    progress: 40,
  };
  const out = await annotateScreenshot(bg, decision, ctx);
  assert.ok(isValidJpeg(out));
});

test('annotate: swipe action handles custom start/end coordinates', async () => {
  const bg = await makeBlankScreenshot();
  const decision: AgentDecision = {
    action: 'swipe',
    params: { startX: 10, startY: 50, endX: 90, endY: 50 },
    reasoning: 'Swiping right to dismiss.',
    progress: 50,
  };
  const out = await annotateScreenshot(bg, decision, ctx);
  assert.ok(isValidJpeg(out));
});

test('annotate: inputText action produces a valid JPEG', async () => {
  const bg = await makeBlankScreenshot();
  const decision: AgentDecision = {
    action: 'inputText',
    params: { text: 'hello world' },
    reasoning: 'Typing greeting into the message field.',
    progress: 60,
  };
  const out = await annotateScreenshot(bg, decision, ctx);
  assert.ok(isValidJpeg(out));
});

test('annotate: wait action (no marker) still produces a valid JPEG', async () => {
  const bg = await makeBlankScreenshot();
  const decision: AgentDecision = {
    action: 'wait',
    params: {},
    reasoning: 'Waiting for the page animation to settle.',
    progress: 15,
  };
  const out = await annotateScreenshot(bg, decision, ctx);
  assert.ok(isValidJpeg(out));
});

// ── XML safety ───────────────────────────────────────────────────

test('annotate: handles reasoning with special XML characters safely', async () => {
  const bg = await makeBlankScreenshot();
  const decision: AgentDecision = {
    action: 'tapText',
    params: { text: 'A & B' },
    reasoning: 'Tapping "Cancel" & dismissing the <alert> dialog.',
    progress: 25,
  };
  // Must not throw from malformed SVG due to unescaped chars
  const out = await annotateScreenshot(bg, decision, ctx);
  assert.ok(isValidJpeg(out));
});

test('annotate: handles CJK reasoning and target text (POC-validated)', async () => {
  const bg = await makeBlankScreenshot();
  const decision: AgentDecision = {
    action: 'tapText',
    params: { text: '設定' },
    reasoning: '點擊「設定」以探索通知偏好設定。',
    progress: 20,
  };
  const out = await annotateScreenshot(bg, decision, ctx);
  assert.ok(isValidJpeg(out));
});

// ── writeAnnotated ───────────────────────────────────────────────

test('writeAnnotated: writes step-NN.jpg into annotated/ subdir', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'annotate-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const bg = await makeBlankScreenshot();
  const decision: AgentDecision = {
    action: 'tap',
    params: { x: 50, y: 50 },
    reasoning: 'Tapping center of screen.',
    progress: 10,
  };
  const annotated = await annotateScreenshot(bg, decision, ctx);
  const rel = await writeAnnotated(dir, 7, annotated);

  assert.equal(rel, 'annotated/step-07.jpg');
  const fileOnDisk = await readFile(path.join(dir, rel));
  assert.ok(isValidJpeg(fileOnDisk));
});

test('writeAnnotated: zero-pads step numbers to 2 digits', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'annotate-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const bg = await makeBlankScreenshot();
  const decision: AgentDecision = {
    action: 'wait',
    params: {},
    reasoning: 'Pausing.',
    progress: 5,
  };
  const annotated = await annotateScreenshot(bg, decision, ctx);

  const rel1 = await writeAnnotated(dir, 1, annotated);
  const rel12 = await writeAnnotated(dir, 12, annotated);

  assert.equal(rel1, 'annotated/step-01.jpg');
  assert.equal(rel12, 'annotated/step-12.jpg');
});

test('writeAnnotated: uses custom prefix for Dynamic Type pass frames', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'annotate-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const bg = await makeBlankScreenshot();
  const decision: AgentDecision = {
    action: 'tap',
    params: { x: 50, y: 50 },
    reasoning: 'Tap.',
    progress: 5,
  };
  const annotated = await annotateScreenshot(bg, decision, ctx);

  const rel = await writeAnnotated(dir, 3, annotated, 'dt');
  assert.equal(rel, 'annotated/dt-03.jpg');
  const fileOnDisk = await readFile(path.join(dir, rel));
  assert.ok(isValidJpeg(fileOnDisk));
});

