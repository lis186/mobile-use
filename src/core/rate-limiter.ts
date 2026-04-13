/**
 * Sliding-window rate limiter for AI API calls.
 *
 * Built for Gemini free tier (15 RPM) with 20 % headroom by default.
 * Paid-tier users pass a high rpmLimit to effectively disable throttling.
 *
 * When the window is full, acquire() blocks and prints a visible
 * "⏸ Rate limit: waiting Xs" line so the user knows the pause is
 * expected, not a hang.
 */

import pc from 'picocolors';

const WINDOW_MS = 60_000;

export interface RateLimiterOptions {
  rpmLimit: number;
  /** Optional logger hook; defaults to console.log with picocolors. */
  log?: (msg: string) => void;
  /** Optional sleep function; defaults to real setTimeout. Tests inject a no-op. */
  sleepFn?: (ms: number) => Promise<void>;
}

export class GeminiRateLimiter {
  private readonly rpmLimit: number;
  private readonly log: (msg: string) => void;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private timestamps: number[] = [];

  constructor(options: RateLimiterOptions) {
    if (!Number.isInteger(options.rpmLimit) || options.rpmLimit < 1) {
      throw new RangeError('GeminiRateLimiter: rpmLimit must be a positive integer');
    }
    this.rpmLimit = options.rpmLimit;
    this.log = options.log ?? ((msg) => console.log(msg));
    this.sleepFn = options.sleepFn ?? defaultSleep;
  }

  /**
   * Block until a call slot is available, then reserve one.
   * Prints a wait-message on throttle so the user sees progress.
   */
  async acquire(): Promise<void> {
    const now = Date.now();
    this.prune(now);

    if (this.timestamps.length < this.rpmLimit) {
      this.timestamps.push(now);
      return;
    }

    const oldest = this.timestamps[0]!;
    const waitMs = Math.max(100, WINDOW_MS - (now - oldest) + 250);
    this.log(
      pc.yellow(
        `  ⏸ Rate limit: waiting ${(waitMs / 1000).toFixed(1)}s ` +
          `(${this.timestamps.length}/${this.rpmLimit} calls in last 60s)`,
      ),
    );
    await this.sleepFn(waitMs);
    return this.acquire(); // re-check after wait
  }

  /** How many slots remain in the current 60 s window. */
  remaining(): number {
    this.prune(Date.now());
    return Math.max(0, this.rpmLimit - this.timestamps.length);
  }

  /** Drop timestamps older than the sliding window. */
  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    this.timestamps = this.timestamps.filter((t) => t >= cutoff);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
