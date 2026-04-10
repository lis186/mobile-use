import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { appendStep, appendIssue, readJsonl } from '../src/core/jsonl-writer.ts';
import type { StepRecord, AuditIssue, StepTiming } from '../src/types.ts';

const emptyTiming: StepTiming = {
  step: 1,
  screenshot_ms: 0,
  tree_ms: 0,
  ai_ms: 0,
  action_ms: 0,
  sleep_ms: 0,
  total_ms: 0,
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
};

function makeStep(step: number): StepRecord {
  return {
    step,
    fingerprint: `fp${step}`,
    screenName: `Screen ${step}`,
    action: 'tap',
    reasoning: `step ${step}`,
    issuesFound: [],
    onboarding: false,
    timing: { ...emptyTiming, step },
  };
}

function makeIssue(id: string): AuditIssue {
  return {
    id,
    title: `Issue ${id}`,
    severity: 'medium',
    screenName: 'TestScreen',
    principle: 'Norman:Affordance',
    evidence: 'A concrete piece of evidence longer than twenty characters.',
    confidence: 80,
    recommendation: 'Do the thing',
    stepNumber: 1,
    evidencePath: `screenshots/${id}.jpg`,
  };
}

// ── Round-trip tests ─────────────────────────────────────────────

test('appendStep + readJsonl: round-trip a single record', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'jsonl-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const rec = makeStep(1);
  await appendStep(dir, rec);

  const read = await readJsonl<StepRecord>(path.join(dir, 'steps.jsonl'));
  assert.equal(read.length, 1);
  assert.deepEqual(read[0], rec);
});

test('appendStep: appends multiple records as separate lines', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'jsonl-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await appendStep(dir, makeStep(1));
  await appendStep(dir, makeStep(2));
  await appendStep(dir, makeStep(3));

  const read = await readJsonl<StepRecord>(path.join(dir, 'steps.jsonl'));
  assert.equal(read.length, 3);
  assert.equal(read[0]?.step, 1);
  assert.equal(read[1]?.step, 2);
  assert.equal(read[2]?.step, 3);
});

test('appendIssue: writes to issues.jsonl, not steps.jsonl', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'jsonl-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await appendIssue(dir, makeIssue('ISSUE-001'));
  await appendIssue(dir, makeIssue('ISSUE-002'));

  const issues = await readJsonl<AuditIssue>(path.join(dir, 'issues.jsonl'));
  const steps = await readJsonl<StepRecord>(path.join(dir, 'steps.jsonl'));
  assert.equal(issues.length, 2);
  assert.equal(steps.length, 0);
});

// ── Edge cases ───────────────────────────────────────────────────

test('readJsonl: missing file returns empty array (ENOENT tolerated)', async () => {
  const result = await readJsonl<StepRecord>('/nonexistent/path/that/will/never/exist.jsonl');
  assert.deepEqual(result, []);
});

test('readJsonl: drops malformed lines but keeps valid ones', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'jsonl-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, 'mixed.jsonl');
  await writeFile(
    file,
    [
      JSON.stringify({ step: 1, action: 'tap' }),
      'this is not valid json',
      JSON.stringify({ step: 2, action: 'scroll' }),
      '',
      '{incomplete',
      JSON.stringify({ step: 3, action: 'back' }),
    ].join('\n'),
  );

  const read = await readJsonl<{ step: number; action: string }>(file);
  assert.equal(read.length, 3);
  assert.equal(read[0]?.step, 1);
  assert.equal(read[1]?.step, 2);
  assert.equal(read[2]?.step, 3);
});

test('appendStep: creates parent directory if it does not exist', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'jsonl-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));

  const nested = path.join(parent, 'does/not/exist/yet');
  await appendStep(nested, makeStep(1));

  const content = await readFile(path.join(nested, 'steps.jsonl'), 'utf-8');
  assert.ok(content.includes('"step":1'));
});
