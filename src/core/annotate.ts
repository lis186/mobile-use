/**
 * Screenshot annotation overlay.
 *
 * Produces a Decision-18 annotated JPEG: the original screenshot with a
 * red tap circle (or arrow/caret for non-point actions), a connector line,
 * and a text card showing Action / Target / Why so the final report is
 * self-explanatory.
 *
 * POC validated (OPS-1): sharp + inline SVG + `-apple-system, "PingFang TC"`
 * font stack renders English and CJK cleanly at retina resolution.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import sharp from 'sharp';
import type { AgentDecision } from '../types.js';

const FONT_STACK = '-apple-system, "PingFang TC", sans-serif';
const JPEG_QUALITY = 85;

export interface AnnotationContext {
  stepNumber: number;
  totalSteps: number;
  model: string;
  target?: string;
  screenName?: string;
}

/**
 * Compose an SVG overlay and composite it onto the raw screenshot.
 * Returns a JPEG buffer ready to write to disk or stream to the live viewer.
 */
export async function annotateScreenshot(
  screenshotBuffer: Buffer,
  decision: AgentDecision,
  ctx: AnnotationContext,
): Promise<Buffer> {
  const meta = await sharp(screenshotBuffer).metadata();
  const w = meta.width ?? 1179;
  const h = meta.height ?? 2556;

  const svg = buildOverlaySvg(w, h, decision, ctx);

  return sharp(screenshotBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}

/** Persist an annotated JPEG to `annotated/step-NN.jpg` under the output dir. */
export async function writeAnnotated(
  outputDir: string,
  stepNumber: number,
  annotatedBuffer: Buffer,
): Promise<string> {
  const dir = path.join(outputDir, 'annotated');
  await mkdir(dir, { recursive: true });
  const name = stepFileName(stepNumber);
  await writeFile(path.join(dir, name), annotatedBuffer);
  return `annotated/${name}`;
}

// ── SVG overlay builder ──────────────────────────────────────────

function buildOverlaySvg(
  w: number,
  h: number,
  decision: AgentDecision,
  ctx: AnnotationContext,
): string {
  const marker = buildMarker(w, h, decision);
  const card = buildTextCard(w, h, decision, ctx);
  const connector = marker.anchorX !== null
    ? `<line x1="${marker.anchorX}" y1="${marker.anchorY}" x2="${card.x + card.w}" y2="${card.y + 40}" stroke="#ff3b30" stroke-width="4"/>`
    : '';

  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <style>
      .title { font: bold 38px ${FONT_STACK}; fill: #ffffff; }
      .label { font: bold 32px ${FONT_STACK}; fill: #ffcc00; }
      .value { font: 32px ${FONT_STACK}; fill: #ffffff; }
      .small { font: 26px ${FONT_STACK}; fill: #cccccc; }
    </style>
    ${marker.svg}
    ${connector}
    ${card.svg}
  </svg>`;
}

/** A marker is the red circle for tap-style actions or an alternative glyph. */
interface Marker {
  svg: string;
  anchorX: number | null;
  anchorY: number;
}

function buildMarker(w: number, h: number, decision: AgentDecision): Marker {
  const params = decision.params ?? {};
  const action = decision.action;

  // Point-based actions (tap/doubleTap/longPress) — draw the red circle
  if (action === 'tap' || action === 'doubleTap' || action === 'longPress') {
    if (params.x != null && params.y != null) {
      const cx = Math.round((params.x / 100) * w);
      const cy = Math.round((params.y / 100) * h);
      return {
        svg: `
          <circle cx="${cx}" cy="${cy}" r="60" fill="none" stroke="#ff3b30" stroke-width="6" opacity="0.4"/>
          <circle cx="${cx}" cy="${cy}" r="38" fill="none" stroke="#ff3b30" stroke-width="8"/>
          <circle cx="${cx}" cy="${cy}" r="14" fill="#ff3b30"/>
        `,
        anchorX: cx - 38,
        anchorY: cy + 20,
      };
    }
  }

  // tapText without coordinates — anchor near the target label (guess top-right)
  if (action === 'tapText' || action === 'pressKey' || action === 'openLink' || action === 'back') {
    return { svg: '', anchorX: null, anchorY: 0 };
  }

  // Scroll / swipe — draw an arrow
  if (action === 'scroll' || action === 'swipe') {
    const sx = Math.round(((params.startX ?? 50) / 100) * w);
    const sy = Math.round(((params.startY ?? 80) / 100) * h);
    const ex = Math.round(((params.endX ?? 50) / 100) * w);
    const ey = Math.round(((params.endY ?? 20) / 100) * h);
    return {
      svg: `
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#ff3b30"/>
          </marker>
        </defs>
        <line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke="#ff3b30" stroke-width="8" marker-end="url(#arrow)"/>
      `,
      anchorX: ex,
      anchorY: ey,
    };
  }

  // inputText — draw a caret indicator
  if (action === 'inputText') {
    const cx = Math.round(w * 0.5);
    const cy = Math.round(h * 0.5);
    return {
      svg: `<rect x="${cx - 4}" y="${cy - 40}" width="8" height="80" fill="#ff3b30"/>`,
      anchorX: cx + 4,
      anchorY: cy,
    };
  }

  // wait / hideKeyboard / done / failed / launchApp / stopApp — no marker
  return { svg: '', anchorX: null, anchorY: 0 };
}

interface TextCard {
  svg: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function buildTextCard(
  screenW: number,
  _screenH: number,
  decision: AgentDecision,
  ctx: AnnotationContext,
): TextCard {
  const cardW = 540;
  const cardH = 320;
  // Place card near the top-right so it doesn't cover common bottom UI.
  const x = Math.max(20, screenW - cardW - 40);
  const y = 340;

  const target = escapeXml((ctx.target ?? firstParamText(decision) ?? '—').slice(0, 40));
  const why = escapeXml(firstSentence(decision.reasoning ?? '').slice(0, 60));
  const tail = escapeXml(((decision.reasoning ?? '').slice(why.length, why.length + 60)).trim());
  const footer = escapeXml(`Step ${ctx.stepNumber}/${ctx.totalSteps} · ${ctx.model}`);

  const svg = `
    <rect x="${x}" y="${y}" width="${cardW}" height="${cardH}" fill="#000000" opacity="0.85" rx="16"/>
    <rect x="${x}" y="${y}" width="${cardW}" height="${cardH}" fill="none" stroke="#ff3b30" stroke-width="3" rx="16"/>
    <text x="${x + 30}" y="${y + 60}" class="title">${escapeXml(decision.action)}</text>
    <text x="${x + 30}" y="${y + 120}" class="label">Target:</text>
    <text x="${x + 170}" y="${y + 120}" class="value">${target}</text>
    <text x="${x + 30}" y="${y + 180}" class="label">Why:</text>
    <text x="${x + 170}" y="${y + 180}" class="value">${why}</text>
    ${tail ? `<text x="${x + 30}" y="${y + 230}" class="small">${tail}</text>` : ''}
    <text x="${x + 30}" y="${y + 290}" class="small">${footer}</text>
  `;

  return { svg, x, y, w: cardW, h: cardH };
}

/** Extract the first meaningful param (text → appId → url) from a decision. */
export function firstParamText(decision: AgentDecision): string | null {
  const p = decision.params;
  if (!p) return null;
  if (p.text) return p.text;
  if (p.appId) return p.appId;
  if (p.url) return p.url;
  return null;
}

function firstSentence(text: string): string {
  const m = text.match(/^[^.!?]+[.!?]?/);
  return (m?.[0] ?? text).trim();
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Canonical step-screenshot filename so the writer and the report renderer stay in sync. */
export function stepFileName(n: number): string {
  return `step-${String(n).padStart(2, '0')}.jpg`;
}
