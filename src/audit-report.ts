/**
 * Markdown audit report renderer.
 *
 * Reads the JSONL sidecar files + timings.json produced by AuditExecutor
 * and emits a self-explanatory `report.md`. Every issue embeds its
 * annotated screenshot so the reader can see WHAT the AI was looking at
 * and WHY it flagged the issue without cross-referencing anything.
 *
 * The render function is pure (takes data, returns a string) so it's
 * unit-testable without touching the filesystem.
 */

import { writeFile, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { readJsonl } from './core/jsonl-writer.js';
import { summarize, type TimingSummary } from './core/step-timing.js';
import { stepFileName } from './core/annotate.js';
import type { StepRecord, AuditIssue, StepTiming } from './types.js';

// ── Public types ─────────────────────────────────────────────

/** Metadata the executor passes to the report writer at finalize time. */
export interface AuditReportContext {
  bundleId: string;
  runner: string;
  deviceInfo?: string;          // e.g. "iPhone 16 Pro (iOS 26.2)"
  model: string;
  startedAt: Date;
  endedAt: Date;
  maxSteps: number;
  /** AuditError code when the run ended early; absent means normal completion. */
  partialReason?: string;
}

/** Inputs to the pure renderer. Splitting this from the I/O function lets tests pass in hand-crafted data. */
export interface AuditReportData {
  ctx: AuditReportContext;
  steps: StepRecord[];
  issues: AuditIssue[];
  timings: StepTiming[];
  summary: TimingSummary;
}

// ── Public functions ─────────────────────────────────────────

/**
 * Read JSONL + timings.json from an audit output dir, render the report,
 * and write it to `report.md`. This is what AuditExecutor.finalize() calls.
 */
export async function finalizeReport(
  outputDir: string,
  ctx: AuditReportContext,
): Promise<void> {
  const [steps, rawIssues, timings] = await Promise.all([
    readJsonl<StepRecord>(path.join(outputDir, 'steps.jsonl')),
    readJsonl<AuditIssue>(path.join(outputDir, 'issues.jsonl')),
    readTimingsJsonSafe(path.join(outputDir, 'timings.json')),
  ]);

  // Two-pass dedup:
  // 1. Exact match on screenName + title (case-insensitive)
  // 2. Fuzzy match: same screenName + Jaccard bigram similarity > 0.5
  const issues = deduplicateIssues(rawIssues);

  const summary = summarize(timings, ctx.model);
  const md = renderReport({ ctx, steps, issues, timings, summary });
  await writeFile(path.join(outputDir, 'report.md'), md, 'utf-8');
}

/**
 * Pure renderer — no filesystem side effects.
 * Exported for unit tests and for callers that want the string without writing it.
 */
export function renderReport(data: AuditReportData): string {
  const parts = [
    renderHeader(data),
    renderPartialBanner(data),
    renderSummary(data),
    renderIssues(data),
    renderScreenMap(data),
    renderDepthFindings(data),
    renderPerformance(data),
    renderNextSteps(data),
  ];
  return parts.filter(Boolean).join('\n\n') + '\n';
}

// ── Section renderers ─────────────────────────────────────────

function renderHeader(data: AuditReportData): string {
  const { ctx, steps } = data;
  const onboardingSteps = steps.filter((s) => s.onboarding).length;
  const effectiveSteps = steps.length - onboardingSteps;
  const uniqueScreens = countUniqueScreens(steps);
  const durationMs = ctx.endedAt.getTime() - ctx.startedAt.getTime();

  const stepsLabel =
    onboardingSteps > 0
      ? `${steps.length} steps (${onboardingSteps} onboarding excluded)`
      : `${steps.length} steps`;

  return `# UX Audit Report: ${escapeMd(ctx.bundleId)}

**Date**: ${ctx.startedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC
**Device**: ${escapeMd(ctx.deviceInfo ?? '(booted simulator)')} (${ctx.runner} runner)
**Model**: ${escapeMd(ctx.model)}
**Duration**: ${formatDuration(durationMs)} · ${stepsLabel}
**Coverage**: ${uniqueScreens} unique screens visited${effectiveSteps !== steps.length ? ` (${effectiveSteps} counted)` : ''}
**Cost**: ${formatCost(data.summary)}`;
}

function renderPartialBanner(data: AuditReportData): string {
  if (!data.ctx.partialReason) return '';
  return `> ⚠️ **Partial report** — the run ended early with \`${data.ctx.partialReason}\`. Findings below cover everything captured up to the failure point.`;
}

function renderSummary(data: AuditReportData): string {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const i of data.issues) counts[i.severity]++;

  const total = data.issues.length;
  const topConcern = pickTopConcern(data.issues);

  const table = `## Summary

| Severity | Count |
|----------|-------|
| 🔴 High   | ${counts.high}     |
| 🟡 Medium | ${counts.medium}     |
| 🟢 Low    | ${counts.low}     |
| **Total** | **${total}**     |`;

  const concernLine = topConcern
    ? `\n\n**Top concern**: ${topConcern}`
    : total === 0
      ? '\n\n**No issues found.** The audit did not surface any UX problems that passed the three-layer quality gate.'
      : '';

  return table + concernLine;
}

function renderIssues(data: AuditReportData): string {
  if (data.issues.length === 0) return '';

  const sorted = [...data.issues].sort(severityRank);
  const header = '## Issues\n';
  const sections = sorted.map((issue) => renderIssueSection(issue, data.ctx)).join('\n\n---\n\n');
  return `${header}\n${sections}`;
}

function renderIssueSection(issue: AuditIssue, ctx: AuditReportContext): string {
  const severityIcon = severityEmoji(issue.severity);
  const annotatedPath = `annotated/${stepFileName(issue.stepNumber)}`;
  const personaLine = issue.persona ? `\n**Affected Persona**: ${escapeMd(issue.persona)}` : '';
  const reauditCmd = buildReauditCommand(ctx.bundleId, issue.screenName);

  return `### ${issue.id} · ${severityIcon} ${capitalize(issue.severity)} · ${escapeMd(issue.title)}

**Screen**: ${escapeMd(issue.screenName)}
**Principle**: ${escapeMd(issue.principle)}${personaLine}
**Confidence**: ${issue.confidence}%
**Step**: ${issue.stepNumber}

![Annotated screenshot](${annotatedPath})

**Evidence** (what the AI observed):
> ${escapeQuote(issue.evidence)}

**Cognitive Impact**:
> ${escapeQuote(issue.cognitiveImpact)}

**Recommendation**:
${escapeMd(issue.recommendation)}

**How to verify the fix**:
\`\`\`bash
${reauditCmd}
\`\`\``;
}

function renderScreenMap(data: AuditReportData): string {
  const { steps } = data;
  if (steps.length === 0) return '';

  // Discovery order by first-seen step
  const firstSeen = new Map<string, StepRecord>();
  for (const s of steps) {
    if (s.onboarding) continue;
    if (!firstSeen.has(s.fingerprint)) firstSeen.set(s.fingerprint, s);
  }

  const discoveryOrder = [...firstSeen.values()].sort((a, b) => a.step - b.step);
  const visitCounts = new Map<string, number>();
  for (const s of steps) {
    if (s.onboarding) continue;
    visitCounts.set(s.fingerprint, (visitCounts.get(s.fingerprint) ?? 0) + 1);
  }

  const listItems = discoveryOrder
    .map((s) => {
      const count = visitCounts.get(s.fingerprint) ?? 1;
      const suffix = count > 1 ? ` (${count} visits)` : '';
      return `- ${escapeMd(s.screenName)}${suffix}`;
    })
    .join('\n');

  const onboardingCount = steps.filter((s) => s.onboarding).length;
  const onboardingLine =
    onboardingCount > 0
      ? `\n\n*${onboardingCount} onboarding step${onboardingCount === 1 ? '' : 's'} detected and excluded from coverage.*`
      : '';

  return `## Screen Map

Exploration path (discovery order):

${listItems}${onboardingLine}`;
}

const IA_DEPTH_THRESHOLD = 4;

// Actions that increase navigation depth when taken from a screen.
const DEPTH_INCREASING = ['tap', 'doubleTap', 'longPress', 'tapText', 'openLink', 'pressKey'];

/**
 * Walk steps in order and record the tap-depth at which each fingerprint was
 * first discovered. Depth starts at 0 (root screen), increments on forward
 * navigation, decrements on back(), resets on launchApp.
 */
function buildDepthMap(steps: StepRecord[]): Map<string, number> {
  const depthMap = new Map<string, number>();
  let depth = 0;
  for (const step of steps) {
    if (step.onboarding) continue;
    if (!depthMap.has(step.fingerprint)) {
      depthMap.set(step.fingerprint, depth);
    }
    const action = step.action;
    if (action.startsWith('back')) {
      depth = Math.max(0, depth - 1);
    } else if (action.startsWith('launchApp')) {
      depth = 0;
    } else if (DEPTH_INCREASING.some((p) => action.startsWith(p))) {
      depth += 1;
    }
  }
  return depthMap;
}

function renderDepthFindings(data: AuditReportData): string {
  const { steps } = data;
  if (steps.length === 0) return '';

  const depthMap = buildDepthMap(steps);
  const firstName = new Map<string, string>();
  for (const step of steps) {
    if (!step.onboarding && !firstName.has(step.fingerprint)) {
      firstName.set(step.fingerprint, step.screenName);
    }
  }

  const deep = [...depthMap.entries()]
    .filter(([, d]) => d > IA_DEPTH_THRESHOLD)
    .map(([fp, depth]) => ({ name: firstName.get(fp) ?? fp, depth }))
    .sort((a, b) => b.depth - a.depth);

  if (deep.length === 0) return '';

  const rows = deep.map(({ name, depth }) => `| ${escapeMd(name)} | ${depth} |`).join('\n');
  const n = deep.length;

  return `## Deep Navigation

${n} screen${n === 1 ? '' : 's'} found more than ${IA_DEPTH_THRESHOLD} taps from the app root. Deep hierarchies increase navigation cost and risk abandonment for infrequent tasks (HIG: navigation depth ≤ ${IA_DEPTH_THRESHOLD}).

| Screen | Taps from root |
|--------|----------------|
${rows}

*Verify whether each screen is reachable via a shortcut (Spotlight, widget, or deep link) before treating depth as a UX issue.*`;
}

function renderPerformance(data: AuditReportData): string {
  const s = data.summary;
  if (s.steps === 0) return '';

  const table = `## Performance

| Metric      | P50     | P95     | Average |
|-------------|---------|---------|---------|
| Screenshot  | ${fmt(s.screenshot.p50)} | ${fmt(s.screenshot.p95)} | ${fmt(s.screenshot.avg)} |
| AI decision | ${fmt(s.ai.p50)} | ${fmt(s.ai.p95)} | ${fmt(s.ai.avg)} |
| Action      | ${fmt(s.action.p50)} | ${fmt(s.action.p95)} | ${fmt(s.action.avg)} |
| Stability   | ${fmt(s.sleep.p50)} | ${fmt(s.sleep.p95)} | ${fmt(s.sleep.avg)} |
| **Total**   | ${fmt(s.total.p50)} | ${fmt(s.total.p95)} | ${fmt(s.total.avg)} |

**Tokens**: ${s.tokens.input.toLocaleString()} in · ${s.tokens.output.toLocaleString()} out${s.tokens.cached > 0 ? ` · ${s.tokens.cached.toLocaleString()} cached` : ''}
**Estimated cost**: $${s.estimatedCost.toFixed(4)} (${s.model})`;

  return table;
}

function renderNextSteps(data: AuditReportData): string {
  const { issues, ctx } = data;
  const highs = issues.filter((i) => i.severity === 'high');
  const mediums = issues.filter((i) => i.severity === 'medium');
  const lows = issues.filter((i) => i.severity === 'low');

  if (issues.length === 0) {
    return `## Next Steps

No issues found. Run a deeper audit (\`--max-steps 40\`) or scope to a specific area (\`--scope "checkout flow"\`) to dig further.`;
  }

  const lines: string[] = ['## Next Steps', ''];

  if (highs.length > 0) {
    lines.push(
      `1. **Fix High-severity issues first** (${highs.length}): ${highs.map((i) => i.id).join(', ')}`,
    );
  }
  if (mediums.length > 0) {
    const idx = highs.length > 0 ? 2 : 1;
    lines.push(`${idx}. **Review Medium issues in design review** (${mediums.length}): ${mediums.map((i) => i.id).join(', ')}`);
  }
  if (lows.length > 0) {
    const idx = (highs.length > 0 ? 1 : 0) + (mediums.length > 0 ? 1 : 0) + 1;
    lines.push(`${idx}. **Defer Low issues to backlog** (${lows.length}): ${lows.map((i) => i.id).join(', ')}`);
  }

  lines.push('');
  lines.push('**Re-audit after fixing**:');
  lines.push('');
  lines.push('```bash');
  lines.push(buildReauditCommand(ctx.bundleId));
  lines.push('```');

  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────

function severityRank(a: AuditIssue, b: AuditIssue): number {
  const order = { high: 0, medium: 1, low: 2 };
  return order[a.severity] - order[b.severity];
}

function severityEmoji(s: AuditIssue['severity']): string {
  switch (s) {
    case 'high':
      return '🔴';
    case 'medium':
      return '🟡';
    case 'low':
      return '🟢';
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function countUniqueScreens(steps: StepRecord[]): number {
  const seen = new Set<string>();
  for (const s of steps) {
    if (s.onboarding) continue;
    seen.add(s.fingerprint);
  }
  return seen.size;
}

/** Format wall-clock duration as "X min Y s" or "Y s". */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const mins = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${mins} min ${rest} s`;
}

function formatCost(summary: TimingSummary): string {
  const dollar = summary.estimatedCost;
  const tokens = `${summary.tokens.input.toLocaleString()} in / ${summary.tokens.output.toLocaleString()} out`;
  return `$${dollar.toFixed(4)} (${tokens} tokens)`;
}

function fmt(ms: number): string {
  if (ms === 0) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms)} ms`;
}

/** Pick a one-line "top concern" summary line for the header. */
function pickTopConcern(issues: AuditIssue[]): string | null {
  if (issues.length === 0) return null;
  const highs = issues.filter((i) => i.severity === 'high');
  if (highs.length === 0) {
    const mediums = issues.filter((i) => i.severity === 'medium');
    if (mediums.length === 0) return null;
    if (mediums.length === 1) return `1 Medium-severity issue: ${escapeMd(mediums[0]!.title)}.`;
    return `${mediums.length} Medium-severity issues — review before next release.`;
  }
  if (highs.length === 1) return `1 High-severity issue: ${escapeMd(highs[0]!.title)} — fix first.`;
  const sameScreen = new Set(highs.map((i) => i.screenName));
  if (sameScreen.size === 1) {
    return `${highs.length} High-severity issues all on the **${escapeMd(highs[0]!.screenName)}** screen — fix these first.`;
  }
  return `${highs.length} High-severity issues across ${sameScreen.size} screens — fix first.`;
}

/** Build a re-audit command the reader can copy-paste. */
function buildReauditCommand(bundleId: string, scope?: string): string {
  const base = `phone-use audit ${bundleId} --runner xctest`;
  return scope ? `${base} --scope "${scope}"` : base;
}

/**
 * Escape characters that would flip interpretation of surrounding prose.
 * Deliberately NOT escaping `()`, `.`, `!`, `+`, `-`, `#`, `{`, `}` because
 * those only have markdown meaning in specific block-level contexts and
 * over-escaping them makes bundle IDs and version strings look ugly.
 */
function escapeMd(s: string): string {
  return s.replace(/([\\`*_[\]])/g, '\\$1');
}

/** Escape for use inside a blockquote — just collapse newlines. */
function escapeQuote(s: string): string {
  return s.replace(/\r?\n/g, ' ').trim();
}

// ── Dedup helpers ────────────────────────────────────────────

/** Extract bigram set from a string for fuzzy comparison. */
function textBigrams(s: string): Set<string> {
  const words = s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  const bigrams = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.add(`${words[i]} ${words[i + 1]}`);
  }
  // Single-word input: use the word itself as the only bigram
  if (words.length === 1 && words[0]) bigrams.add(words[0]);
  return bigrams;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const JACCARD_THRESHOLD = 0.5;

/**
 * Four-pass dedup:
 * Pass 1. Exact match on screenName + title (case-insensitive)
 * Pass 2. Same screen + same principle → keep only the first (highest-confidence) instance.
 *    Catches bilingual paraphrases where Jaccard fails ("Learn More" vs "進一步瞭解").
 * Pass 3. Fuzzy title match within same screen (Jaccard > 0.5)
 * Pass 4. Cross-screen: same principle + similar title OR similar evidence — catches the
 *    case where the AI gives different screen names to the same screen
 *    (e.g. "蘋方-簡 > 極細體 (Page 2)" vs "Font example page 2 (極細體)")
 */
function deduplicateIssues(raw: AuditIssue[]): AuditIssue[] {
  // Pass 1: exact case-insensitive
  const exactSeen = new Set<string>();
  const afterExact = raw.filter((issue) => {
    const key = `${issue.screenName.toLowerCase()}\0${issue.title.toLowerCase()}`;
    if (exactSeen.has(key)) return false;
    exactSeen.add(key);
    return true;
  });

  // Pass 2: same screen + same principle → keep only first (bilingual paraphrase guard)
  const seenScreenPrinciple = new Set<string>();
  const afterScreenPrinciple = afterExact.filter((issue) => {
    const key = `${issue.screenName.toLowerCase()}\0${issue.principle.toLowerCase()}`;
    if (seenScreenPrinciple.has(key)) return false;
    seenScreenPrinciple.add(key);
    return true;
  });

  // Pass 3: fuzzy within same screen
  const afterFuzzy: AuditIssue[] = [];
  for (const issue of afterScreenPrinciple) {
    const screen = issue.screenName.toLowerCase();
    const bigrams = textBigrams(issue.title);
    const isDup = afterFuzzy.some((existing) => {
      if (existing.screenName.toLowerCase() !== screen) return false;
      return jaccardSimilarity(bigrams, textBigrams(existing.title)) >= JACCARD_THRESHOLD;
    });
    if (!isDup) afterFuzzy.push(issue);
  }

  // Pass 4: cross-screen — same principle + (similar title OR similar evidence)
  const kept: AuditIssue[] = [];
  for (const issue of afterFuzzy) {
    const principle = issue.principle.toLowerCase();
    const titleBi = textBigrams(issue.title);
    const evidenceBi = textBigrams(issue.evidence);
    const isDup = kept.some((existing) => {
      if (existing.principle.toLowerCase() !== principle) return false;
      const titleSim = jaccardSimilarity(titleBi, textBigrams(existing.title));
      if (titleSim >= JACCARD_THRESHOLD) return true;
      const evidenceSim = jaccardSimilarity(evidenceBi, textBigrams(existing.evidence));
      return evidenceSim >= JACCARD_THRESHOLD;
    });
    if (!isDup) kept.push(issue);
  }
  return kept;
}

/** Read timings.json if present, returning the raw StepTiming[] for re-summarizing. */
async function readTimingsJsonSafe(filePath: string): Promise<StepTiming[]> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as { timings?: StepTiming[] };
    return parsed.timings ?? [];
  } catch {
    return [];
  }
}
