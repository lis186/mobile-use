import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, estimateCost } from '../src/core/step-timing.ts';
import type { StepTiming } from '../src/types.ts';

function stub(overrides: Partial<StepTiming>): StepTiming {
  return {
    step: 1,
    screenshot_ms: 100,
    tree_ms: 0,
    ai_ms: 1000,
    action_ms: 50,
    sleep_ms: 300,
    total_ms: 1450,
    input_tokens: 500,
    output_tokens: 200,
    cached_tokens: 0,
    ...overrides,
  };
}

// ── Percentile math (nearest-rank, Math.ceil(n*p)-1) ─────────────

test('summarize: P50 and P95 on a known 10-sample distribution', () => {
  // Sorted ai_ms: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
  // nearest-rank P50 = index ceil(10*0.5)-1 = 4 → 500
  // nearest-rank P95 = index ceil(10*0.95)-1 = 9 → 1000
  const timings: StepTiming[] = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map(
    (ai, i) => stub({ step: i + 1, ai_ms: ai }),
  );
  const summary = summarize(timings, 'gemini-2.5-flash');
  assert.equal(summary.ai.p50, 500);
  assert.equal(summary.ai.p95, 1000);
  assert.equal(summary.ai.max, 1000);
});

test('summarize: P95 on 20 samples picks the 19th, not the 20th', () => {
  // Sorted: 100, 200, ... 2000
  // Math.ceil(20*0.95)-1 = 19 - 1 = 18 → 1900
  const timings: StepTiming[] = Array.from({ length: 20 }, (_, i) =>
    stub({ step: i + 1, ai_ms: (i + 1) * 100 }),
  );
  const summary = summarize(timings, 'gemini-2.5-flash');
  assert.equal(summary.ai.p95, 1900);
});

test('summarize: small N (2 samples)', () => {
  // Sorted: [100, 200]
  // P50 index = ceil(2*0.5)-1 = 0 → 100
  // P95 index = ceil(2*0.95)-1 = 1 → 200
  const timings: StepTiming[] = [stub({ ai_ms: 100 }), stub({ ai_ms: 200 })];
  const summary = summarize(timings, 'gemini-2.5-flash');
  assert.equal(summary.ai.p50, 100);
  assert.equal(summary.ai.p95, 200);
});

test('summarize: single sample', () => {
  const summary = summarize([stub({ ai_ms: 1234 })], 'gemini-2.5-flash');
  assert.equal(summary.ai.p50, 1234);
  assert.equal(summary.ai.p95, 1234);
  assert.equal(summary.ai.avg, 1234);
  assert.equal(summary.ai.max, 1234);
});

test('summarize: empty array returns zeros', () => {
  const summary = summarize([], 'gemini-2.5-flash');
  assert.equal(summary.steps, 0);
  assert.equal(summary.ai.p50, 0);
  assert.equal(summary.ai.p95, 0);
  assert.equal(summary.total.p50, 0);
});

// ── Token aggregation ────────────────────────────────────────────

test('summarize: totals tokens correctly across steps', () => {
  const timings = [
    stub({ input_tokens: 100, output_tokens: 50 }),
    stub({ input_tokens: 200, output_tokens: 100 }),
    stub({ input_tokens: 300, output_tokens: 150 }),
  ];
  const summary = summarize(timings, 'gemini-2.5-flash');
  assert.equal(summary.tokens.input, 600);
  assert.equal(summary.tokens.output, 300);
});

test('summarize: tracks cached tokens separately', () => {
  const timings = [
    stub({ input_tokens: 500, cached_tokens: 300 }),
    stub({ input_tokens: 500, cached_tokens: 400 }),
  ];
  const summary = summarize(timings, 'gemini-2.5-flash');
  assert.equal(summary.tokens.input, 1000);
  assert.equal(summary.tokens.cached, 700);
});

// ── Cost estimation ──────────────────────────────────────────────

test('estimateCost: known prices for gemini-2.5-flash', () => {
  // 1M input + 1M output → $0.075 + $0.30 = $0.375
  const cost = estimateCost(1_000_000, 1_000_000, 0, 'gemini-2.5-flash');
  assert.equal(cost, 0.375);
});

test('estimateCost: cached tokens are charged at the cached rate', () => {
  // All input cached → charged at $0.019/M, not $0.075/M
  // 1M cached + 0 output = $0.019
  const cost = estimateCost(1_000_000, 0, 1_000_000, 'gemini-2.5-flash');
  assert.ok(cost < 0.05);
  assert.ok(cost > 0.01);
});

test('estimateCost: unknown model returns 0', () => {
  const cost = estimateCost(1000, 500, 0, 'nonexistent-model');
  assert.equal(cost, 0);
});

test('estimateCost: typical 25-step audit cost is in expected range (POC validated)', () => {
  // POC measured ~700 tokens per call, 25 steps ≈ ~$0.003 with cached prompt
  const cost = estimateCost(
    25 * 400,  // input tokens, most cached after step 1
    25 * 300,  // output tokens
    25 * 300,  // cached tokens
    'gemini-2.5-flash',
  );
  assert.ok(cost < 0.01, `cost ${cost} should be well under $0.01`);
});
