import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  auditDecisionSchema,
  auditIssueSchema,
  navigationSchema,
} from '../src/schemas/audit.ts';

// ── Navigation schema ────────────────────────────────────────────

test('navigation: accepts tapText action with target and text', () => {
  const parsed = navigationSchema.safeParse({
    action: 'tapText',
    target: 'Settings button',
    text: 'Settings',
  });
  assert.ok(parsed.success);
});

test('navigation: accepts tap action with x/y percentages', () => {
  const parsed = navigationSchema.safeParse({
    action: 'tap',
    target: 'Search icon',
    x: 90,
    y: 10,
  });
  assert.ok(parsed.success);
});

test('navigation: rejects x > 100 (percentage bound)', () => {
  const parsed = navigationSchema.safeParse({
    action: 'tap',
    target: 'Element',
    x: 150,
    y: 50,
  });
  assert.ok(!parsed.success);
});

test('navigation: rejects unknown action enum', () => {
  const parsed = navigationSchema.safeParse({
    action: 'flyAroundInCircles',
    target: 'nothing',
  });
  assert.ok(!parsed.success);
});

// ── Issue schema — evidence and confidence bounds ───────────────

test('issue: accepts fully-formed issue with all required fields', () => {
  const parsed = auditIssueSchema.safeParse({
    title: 'Search icon too small',
    severity: 'high',
    principle: 'iOS HIG:Tap Target',
    evidence: 'The search icon is approximately 20x20pt at top-right of the navigation bar.',
    confidence: 85,
    recommendation: 'Increase hit area to minimum 44x44pt using extendedEdgeInsets',
  });
  assert.ok(parsed.success);
});

test('issue: rejects evidence shorter than 20 chars (three-layer quality gate)', () => {
  const parsed = auditIssueSchema.safeParse({
    title: 'Something bad',
    severity: 'medium',
    principle: 'Nielsen:Consistency',
    evidence: 'Too short',  // 9 chars, below the 20-char minimum
    confidence: 80,
    recommendation: 'Fix it',
  });
  assert.ok(!parsed.success);
  if (!parsed.success) {
    const evidenceErr = parsed.error.issues.find((i) => i.path.includes('evidence'));
    assert.ok(evidenceErr, 'should flag the evidence field');
  }
});

test('issue: rejects confidence < 0', () => {
  const parsed = auditIssueSchema.safeParse({
    title: 'Test',
    severity: 'low',
    principle: 'X',
    evidence: 'A valid evidence string of adequate length',
    confidence: -5,
    recommendation: 'Fix',
  });
  assert.ok(!parsed.success);
});

test('issue: rejects confidence > 100', () => {
  const parsed = auditIssueSchema.safeParse({
    title: 'Test',
    severity: 'low',
    principle: 'X',
    evidence: 'A valid evidence string of adequate length',
    confidence: 150,
    recommendation: 'Fix',
  });
  assert.ok(!parsed.success);
});

test('issue: rejects non-integer confidence (should be int)', () => {
  const parsed = auditIssueSchema.safeParse({
    title: 'Test',
    severity: 'low',
    principle: 'X',
    evidence: 'A valid evidence string of adequate length',
    confidence: 85.5,
    recommendation: 'Fix',
  });
  assert.ok(!parsed.success);
});

test('issue: rejects invalid severity value', () => {
  const parsed = auditIssueSchema.safeParse({
    title: 'Test',
    severity: 'catastrophic',
    principle: 'X',
    evidence: 'A valid evidence string of adequate length',
    confidence: 85,
    recommendation: 'Fix',
  });
  assert.ok(!parsed.success);
});

// ── Full AuditDecision — optional audit block ───────────────────

test('decision: audit block can be omitted (clean screen, no issues)', () => {
  const parsed = auditDecisionSchema.safeParse({
    navigation: { action: 'tapText', target: 'Next', text: 'Next' },
    screenName: 'Welcome',
    reasoning: 'Moving to the next screen to continue exploration.',
    progress: 20,
  });
  assert.ok(parsed.success);
  if (parsed.success) {
    assert.equal(parsed.data.audit, undefined);
    assert.equal(parsed.data.screenName, 'Welcome');
  }
});

test('decision: audit block with empty issues array is valid', () => {
  const parsed = auditDecisionSchema.safeParse({
    navigation: { action: 'tap', target: 'button', x: 50, y: 50 },
    screenName: 'Home',
    audit: { issues: [] },
    reasoning: 'Exploring the main screen.',
    progress: 10,
  });
  assert.ok(parsed.success);
});

test('decision: screenName is required at top level (BUG-B fix)', () => {
  const parsed = auditDecisionSchema.safeParse({
    navigation: { action: 'tap', target: 'x', x: 50, y: 50 },
    reasoning: 'Tapping the center of the screen',
    progress: 20,
    // missing screenName
  });
  assert.ok(!parsed.success);
  if (!parsed.success) {
    const nameErr = parsed.error.issues.find((i) => i.path.includes('screenName'));
    assert.ok(nameErr, 'should flag the missing screenName field');
  }
});

test('decision: progress must be integer 0-100 (POC-validated fix)', () => {
  const bad = auditDecisionSchema.safeParse({
    navigation: { action: 'tap', target: 'x', x: 50, y: 50 },
    screenName: 'Home',
    reasoning: 'Tapping the center of the screen',
    progress: 0.2,  // not an integer
  });
  assert.ok(!bad.success);

  const good = auditDecisionSchema.safeParse({
    navigation: { action: 'tap', target: 'x', x: 50, y: 50 },
    screenName: 'Home',
    reasoning: 'Tapping the center of the screen',
    progress: 20,
  });
  assert.ok(good.success, `expected success, got errors: ${JSON.stringify(good.error?.issues)}`);
});

test('decision: onboardingDetected is optional', () => {
  const parsed = auditDecisionSchema.safeParse({
    navigation: { action: 'tapText', target: 'Skip', text: 'Skip' },
    screenName: 'Tutorial 1',
    reasoning: 'Detected onboarding.',
    progress: 5,
    onboardingDetected: true,
  });
  assert.ok(parsed.success);
});

test('decision: rejects missing required fields (navigation/reasoning/progress)', () => {
  const parsed = auditDecisionSchema.safeParse({
    navigation: { action: 'tap', target: 'x' },
    screenName: 'x',
    // missing reasoning and progress
  });
  assert.ok(!parsed.success);
});
