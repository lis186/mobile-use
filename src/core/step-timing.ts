/**
 * Per-step performance instrumentation for audit runs.
 *
 * The executor pushes one StepTiming per step; at finalize the summarize()
 * helper computes P50/P95/avg per segment and estimateCost() converts the
 * total token counts into a dollar figure per known model.
 */

import type { StepTiming } from '../types.js';

export type { StepTiming };

export interface TimingStats {
  p50: number;
  p95: number;
  avg: number;
  max: number;
}

export interface TimingSummary {
  steps: number;
  screenshot: TimingStats;
  tree: TimingStats;
  ai: TimingStats;
  action: TimingStats;
  sleep: TimingStats;
  total: TimingStats;
  tokens: {
    input: number;
    output: number;
    cached: number;
  };
  estimatedCost: number;
  model: string;
}

/** Nearest-rank percentile on a sorted array; stable for small N. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1));
  return sorted[idx] ?? 0;
}

function stats(values: number[]): TimingStats {
  if (values.length === 0) return { p50: 0, p95: 0, avg: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = sum / sorted.length;
  const max = sorted[sorted.length - 1] ?? 0;
  return { p50, p95, avg: Math.round(avg), max };
}

/** Compute a full summary from raw timing records. */
export function summarize(timings: StepTiming[], model: string): TimingSummary {
  const inputTokens = timings.reduce((a, t) => a + t.input_tokens, 0);
  const outputTokens = timings.reduce((a, t) => a + t.output_tokens, 0);
  const cachedTokens = timings.reduce((a, t) => a + (t.cached_tokens ?? 0), 0);
  return {
    steps: timings.length,
    screenshot: stats(timings.map((t) => t.screenshot_ms)),
    tree: stats(timings.map((t) => t.tree_ms)),
    ai: stats(timings.map((t) => t.ai_ms)),
    action: stats(timings.map((t) => t.action_ms)),
    sleep: stats(timings.map((t) => t.sleep_ms)),
    total: stats(timings.map((t) => t.total_ms)),
    tokens: { input: inputTokens, output: outputTokens, cached: cachedTokens },
    estimatedCost: estimateCost(inputTokens, outputTokens, cachedTokens, model),
    model,
  };
}

/**
 * Estimated price table (USD per million tokens) for models we ship with.
 * Numbers are rounded public prices; the audit summary is a hint, not a bill.
 */
const MODEL_PRICING: Record<string, { input: number; output: number; cached?: number }> = {
  'gemini-2.5-flash': { input: 0.075, output: 0.30, cached: 0.019 },
  'gemini-2.5-pro': { input: 1.25, output: 5.0, cached: 0.31 },
  'gpt-4o': { input: 2.50, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
};

export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number,
  model: string,
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  const chargedInput = Math.max(0, inputTokens - cachedTokens);
  const cost =
    (chargedInput * pricing.input) / 1_000_000 +
    (outputTokens * pricing.output) / 1_000_000 +
    (cachedTokens * (pricing.cached ?? pricing.input * 0.25)) / 1_000_000;
  return Math.round(cost * 10_000) / 10_000;
}
