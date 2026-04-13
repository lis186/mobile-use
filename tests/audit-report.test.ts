import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport, type AuditReportData, type AuditReportContext } from '../src/audit-report.ts';
import type { StepRecord, AuditIssue, StepTiming } from '../src/types.ts';
import { summarize } from '../src/core/step-timing.ts';

// ── Fixture builders ──────────────────────────────────────────

const emptyTiming: StepTiming = {
  step: 1,
  screenshot_ms: 420,
  tree_ms: 0,
  ai_ms: 3200,
  action_ms: 180,
  sleep_ms: 1100,
  total_ms: 4900,
  input_tokens: 400,
  output_tokens: 200,
  cached_tokens: 100,
};

function makeCtx(overrides: Partial<AuditReportContext> = {}): AuditReportContext {
  const startedAt = new Date('2026-04-12T14:30:00Z');
  return {
    bundleId: 'com.apple.Preferences',
    runner: 'xctest',
    deviceInfo: 'iPhone 16 Pro (iOS 26.2)',
    model: 'gemini-2.5-flash',
    startedAt,
    endedAt: new Date(startedAt.getTime() + 4 * 60 * 1000 + 32 * 1000), // +4min32s
    maxSteps: 25,
    ...overrides,
  };
}

function makeStep(i: number, overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    step: i,
    fingerprint: `fp${String(i).padStart(4, '0')}`,
    screenName: `Screen ${i}`,
    action: 'tap(50,50)',
    reasoning: `Step ${i} reasoning`,
    issuesFound: [],
    onboarding: false,
    timing: { ...emptyTiming, step: i },
    ...overrides,
  };
}

function makeIssue(id: string, overrides: Partial<AuditIssue> = {}): AuditIssue {
  return {
    id,
    title: `Test issue ${id}`,
    severity: 'medium',
    screenName: 'Chat list',
    principle: 'Norman:Affordance',
    evidence: 'A concrete piece of visual evidence longer than twenty characters.',
    cognitiveImpact: 'Users cannot distinguish this element from static content, requiring trial-and-error.',
    confidence: 80,
    recommendation: 'Do the specific thing mentioned in the evidence',
    stepNumber: 5,
    evidencePath: `screenshots/${id}.jpg`,
    ...overrides,
  };
}

function makeData(overrides: Partial<AuditReportData> = {}): AuditReportData {
  const steps = overrides.steps ?? [makeStep(1), makeStep(2), makeStep(3)];
  const issues = overrides.issues ?? [];
  const timings = overrides.timings ?? steps.map((s) => s.timing);
  return {
    ctx: overrides.ctx ?? makeCtx(),
    steps,
    issues,
    timings,
    summary: overrides.summary ?? summarize(timings, 'gemini-2.5-flash'),
  };
}

// ── Header ────────────────────────────────────────────────────

test('report header includes bundle, device, model, duration, coverage, cost', () => {
  const md = renderReport(makeData());
  assert.match(md, /# UX Audit Report: com\.apple\.Preferences/);
  assert.match(md, /iPhone 16 Pro \(iOS 26\.2\)/);
  assert.match(md, /gemini-2\.5-flash/);
  assert.match(md, /Duration\*\*: 4 min 32 s/);
  assert.match(md, /Coverage\*\*: 3 unique screens/);
  assert.match(md, /Cost\*\*: \$0\./);
});

test('report header excludes onboarding-tagged steps from coverage', () => {
  const data = makeData({
    steps: [
      makeStep(1, { onboarding: true, screenName: 'Welcome Tutorial' }),
      makeStep(2, { onboarding: true, screenName: 'What\'s New' }),
      makeStep(3, { screenName: 'Home' }),
      makeStep(4, { screenName: 'Settings' }),
    ],
  });
  const md = renderReport(data);
  assert.match(md, /2 unique screens/);
  assert.match(md, /4 steps \(2 onboarding excluded\)/);
});

// ── Severity summary ──────────────────────────────────────────

test('summary table counts issues by severity', () => {
  const data = makeData({
    issues: [
      makeIssue('ISSUE-001', { severity: 'high' }),
      makeIssue('ISSUE-002', { severity: 'high' }),
      makeIssue('ISSUE-003', { severity: 'medium' }),
      makeIssue('ISSUE-004', { severity: 'low' }),
    ],
  });
  const md = renderReport(data);
  assert.match(md, /🔴 High\s*\|\s*2/);
  assert.match(md, /🟡 Medium\s*\|\s*1/);
  assert.match(md, /🟢 Low\s*\|\s*1/);
  assert.match(md, /\*\*Total\*\*\s*\|\s*\*\*4\*\*/);
});

test('summary shows "no issues" message when the run is clean', () => {
  const md = renderReport(makeData());
  assert.match(md, /No issues found/);
  assert.match(md, /three-layer quality gate/);
});

test('summary top-concern line clusters Highs on a single screen', () => {
  const data = makeData({
    issues: [
      makeIssue('ISSUE-001', { severity: 'high', screenName: 'Chat list' }),
      makeIssue('ISSUE-002', { severity: 'high', screenName: 'Chat list' }),
    ],
  });
  const md = renderReport(data);
  assert.match(md, /2 High-severity issues all on the \*\*Chat list\*\* screen/);
});

// ── Issue rendering ───────────────────────────────────────────

test('each issue section embeds its annotated screenshot', () => {
  const data = makeData({
    issues: [
      makeIssue('ISSUE-001', { severity: 'high', stepNumber: 3 }),
      makeIssue('ISSUE-002', { severity: 'low', stepNumber: 15 }),
    ],
  });
  const md = renderReport(data);
  assert.match(md, /!\[Annotated screenshot\]\(annotated\/step-03\.jpg\)/);
  assert.match(md, /!\[Annotated screenshot\]\(annotated\/step-15\.jpg\)/);
});

test('issues are rendered in severity order (high → medium → low)', () => {
  const data = makeData({
    issues: [
      makeIssue('ISSUE-001', { severity: 'low', title: 'Low A' }),
      makeIssue('ISSUE-002', { severity: 'high', title: 'High A' }),
      makeIssue('ISSUE-003', { severity: 'medium', title: 'Med A' }),
    ],
  });
  const md = renderReport(data);
  const highIdx = md.indexOf('High A');
  const medIdx = md.indexOf('Med A');
  const lowIdx = md.indexOf('Low A');
  assert.ok(highIdx > 0 && medIdx > highIdx && lowIdx > medIdx, `order: ${highIdx}, ${medIdx}, ${lowIdx}`);
});

test('each issue carries evidence, confidence, and a re-audit command', () => {
  const data = makeData({
    issues: [
      makeIssue('ISSUE-001', { confidence: 92, evidence: 'A concrete piece of visible evidence.' }),
    ],
  });
  const md = renderReport(data);
  assert.match(md, /Confidence\*\*: 92%/);
  assert.match(md, /A concrete piece of visible evidence/);
  assert.match(md, /phone-use audit com\.apple\.Preferences --runner xctest/);
});

test('issues section omitted when there are no issues', () => {
  const md = renderReport(makeData());
  assert.ok(!md.includes('## Issues\n'));
});

// ── Screen map ────────────────────────────────────────────────

test('screen map lists visited screens in discovery order', () => {
  const data = makeData({
    steps: [
      makeStep(1, { screenName: 'Home', fingerprint: 'fpA' }),
      makeStep(2, { screenName: 'Settings', fingerprint: 'fpB' }),
      makeStep(3, { screenName: 'Home', fingerprint: 'fpA' }), // revisit
      makeStep(4, { screenName: 'Profile', fingerprint: 'fpC' }),
    ],
  });
  const md = renderReport(data);
  const homeIdx = md.indexOf('Home (2 visits)');
  const settingsIdx = md.indexOf('Settings');
  const profileIdx = md.indexOf('Profile');
  assert.ok(homeIdx > 0, 'Home with visit count');
  assert.ok(settingsIdx > homeIdx, 'Settings after Home');
  assert.ok(profileIdx > settingsIdx, 'Profile after Settings');
});

test('screen map notes onboarding steps as excluded', () => {
  const data = makeData({
    steps: [
      makeStep(1, { onboarding: true, screenName: 'Tutorial' }),
      makeStep(2, { screenName: 'Home' }),
    ],
  });
  const md = renderReport(data);
  assert.match(md, /1 onboarding step detected and excluded/);
});

// ── Performance ───────────────────────────────────────────────

test('performance table renders P50/P95/avg and token cost', () => {
  const md = renderReport(makeData());
  assert.match(md, /## Performance/);
  assert.match(md, /Screenshot/);
  assert.match(md, /AI decision/);
  assert.match(md, /\*\*Total\*\*/);
  assert.match(md, /Tokens\*\*:/);
  assert.match(md, /Estimated cost\*\*: \$/);
});

// ── Next steps ────────────────────────────────────────────────

test('next steps prioritises High severity and lists IDs', () => {
  const data = makeData({
    issues: [
      makeIssue('ISSUE-001', { severity: 'high' }),
      makeIssue('ISSUE-002', { severity: 'medium' }),
      makeIssue('ISSUE-003', { severity: 'low' }),
    ],
  });
  const md = renderReport(data);
  assert.match(md, /Fix High-severity issues first.*ISSUE-001/);
  assert.match(md, /Review Medium issues.*ISSUE-002/);
  assert.match(md, /Defer Low issues.*ISSUE-003/);
  assert.match(md, /Re-audit after fixing/);
});

test('next steps falls back to scope hint when no issues found', () => {
  const md = renderReport(makeData());
  assert.match(md, /No issues found. Run a deeper audit/);
});

// ── Partial run banner ────────────────────────────────────────

test('partial banner renders when partialReason is present', () => {
  const data = makeData({
    ctx: makeCtx({ partialReason: 'E_USER_ABORTED' }),
  });
  const md = renderReport(data);
  assert.match(md, /⚠️ \*\*Partial report\*\*/);
  assert.match(md, /E_USER_ABORTED/);
});

test('partial banner omitted on normal completion', () => {
  const md = renderReport(makeData());
  assert.ok(!md.includes('Partial report'));
});

// ── End-to-end shape ──────────────────────────────────────────

test('renderReport always ends with a trailing newline', () => {
  const md = renderReport(makeData());
  assert.ok(md.endsWith('\n'));
});

test('renderReport returns a non-empty string for empty-ish input', () => {
  const md = renderReport({
    ctx: makeCtx(),
    steps: [],
    issues: [],
    timings: [],
    summary: summarize([], 'gemini-2.5-flash'),
  });
  assert.ok(md.length > 0);
  assert.match(md, /# UX Audit Report/);
});
