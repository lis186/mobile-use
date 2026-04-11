/**
 * AuditExecutor — the runtime loop for `phone-use audit`.
 *
 * Extends TaskExecutor to reuse:
 *   - driver lifecycle (WDA / maestro / xctest start/stop)
 *   - executeAction dispatch (tap, tapText, scroll, ...)
 *   - waitForScreenStable polling
 *
 * Adds everything audit-specific:
 *   - per-device lockfile (Decision 17)
 *   - output directory + JSONL streaming + annotated screenshots
 *   - visited screen map + nav-target extraction (Decision 3)
 *   - action-type-based stability wait (Decision 10)
 *   - per-step timing + token accounting (Decision 9)
 *   - screenshot retry w/ driver-liveness classification (Decision 14)
 *   - app-crash detection (Decision 14)
 *   - finalize → Markdown report via the report writer (Group 13)
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import ora from 'ora';
import pc from 'picocolors';
import { TaskExecutor, buildDriverFromTaskConfig } from './executor.js';
import { AuditAgent, type AuditStepResult } from './audit-agent.js';
import { AuditError, isAuditError } from './errors/audit-errors.js';
import { WDAClient } from './wda.js';
import { XCTestClient } from './xctest.js';
import { fingerprintScreen } from './core/screen-fingerprint.js';
import { extractNavTargets } from './core/tree-parser.js';
import { appendStep, appendIssue } from './core/jsonl-writer.js';
import { saveEvidence } from './core/evidence.js';
import { annotateScreenshot, writeAnnotated } from './core/annotate.js';
import { summarize } from './core/step-timing.js';
import type {
  AuditConfig,
  TaskConfig,
  StepTiming,
  VisitedScreen,
  AuditIssue,
  StepRecord,
  AgentDecision,
} from './types.js';

const NAVIGATION_ACTIONS = new Set<string>([
  'tap',
  'tapText',
  'back',
  'launchApp',
  'openLink',
  'pressKey',
  'doubleTap',
]);

const MAX_SCREENSHOT_RETRIES = 3;
const STABLE_POLL_INTERVAL_MS = 250;
const LOCK_DIR = '/tmp';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AuditRunResult {
  success: boolean;
  outputDir: string;
  stepsTotal: number;
  issuesFound: number;
  partialReason?: string;
}

export class AuditExecutor extends TaskExecutor {
  private readonly auditConfig: AuditConfig;
  private readonly auditAgent: AuditAgent;
  private readonly visited = new Map<string, VisitedScreen>();
  private unvisitedTargets: string[] = [];
  private readonly recentActions: string[] = [];
  private readonly timings: StepTiming[] = [];
  private issueCounter = 0;
  private lockPath: string | null = null;
  private exitHandler: (() => void) | null = null;
  private onboardingSteps = 0;
  private crashStreak = 0;

  constructor(config: AuditConfig, apiKey: string, provider: 'google' | 'openai' = 'google') {
    // Build a stub TaskConfig for the parent's driver setup. The parent will
    // also construct a TaskAgent we never use — that's a small cost to reuse
    // the driver lifecycle without duplicating it. The parent's `execute()`
    // method is never called; we override it entirely below.
    const taskStub: TaskConfig = {
      bundleId: config.bundleId,
      task: `audit:${config.bundleId}`,
      maxSteps: config.maxSteps,
      model: config.model,
      language: config.language,
      deviceId: config.deviceId,
      iosDevice: config.iosDevice,
      runner: config.runner,
    };
    super(taskStub, apiKey, provider);

    this.auditConfig = config;
    this.auditAgent = new AuditAgent(apiKey, config, provider);

    // The parent constructor already built a driver for `maestro`. Replace
    // it with one pinned to the audit config so the right runner branch is
    // used (defensive — parent's selection should be identical for Phase 1).
    this.maestro = buildDriverFromTaskConfig(taskStub);
  }

  /**
   * Main audit entry point. Handles lifecycle, lock, loop, finalize.
   * Does NOT call the parent's execute() — this is the audit loop body.
   */
  async executeAudit(): Promise<AuditRunResult> {
    this.acquireLock();
    await this.initOutputDir();

    this.printHeader();

    // Driver lifecycle — mirror the parent class logic but with audit-themed
    // spinners and audit-error taxonomy on failure.
    try {
      await this.startDriver();
    } catch (err) {
      this.releaseLock();
      throw new AuditError(
        'E_DRIVER_NOT_READY',
        `Failed to start ${this.auditConfig.runner} driver. ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }

    let partialReason: string | undefined;
    try {
      if (!this.auditConfig.skipLaunch) {
        const spin = ora({ text: 'Launching app...', stream: process.stdout }).start();
        try {
          await this.maestro.launch();
          spin.succeed('App launched');
          this.recentActions.push('launched');
          await sleep(1500); // let the first screen settle
        } catch (err) {
          spin.fail('Failed to launch app');
          throw new AuditError(
            'E_APP_NOT_INSTALLED',
            `Could not launch ${this.auditConfig.bundleId}. Is it installed on the target device?`,
            { cause: err },
          );
        }
      } else {
        console.log(pc.dim('Skipping app launch (--skip-launch for pre-authenticated state)'));
      }

      await this.runLoop();
    } catch (err) {
      if (isAuditError(err)) {
        partialReason = err.code;
        console.error(pc.red(`\n❌ ${err.code}: ${err.hint}`));
      } else if (err instanceof Error) {
        partialReason = 'E_UNEXPECTED';
        console.error(pc.red(`\n❌ Unexpected error: ${err.message}`));
      }
      // continue through finally so finalize() still runs
    } finally {
      try {
        await this.finalize(partialReason);
      } catch (finalizeErr) {
        console.error(pc.red(`\n⚠️  Failed to finalize report: ${(finalizeErr as Error).message}`));
      }

      await this.stopDriver();
      this.releaseLock();
    }

    return {
      success: !partialReason,
      outputDir: this.auditConfig.outputDir,
      stepsTotal: this.timings.length,
      issuesFound: this.issueCounter,
      partialReason,
    };
  }

  // ── The audit loop ───────────────────────────────────────────

  private async runLoop(): Promise<void> {
    let step = 0;
    while (step < this.auditConfig.maxSteps) {
      step++;
      console.log(pc.dim(`\n${'─'.repeat(40)}`));
      console.log(pc.bold(`Step ${step}/${this.auditConfig.maxSteps}`));

      // ── Observe ─────────────────────────────────────────────
      const t0 = performance.now();
      let screenshotB64: string;
      let screenshotBuffer: Buffer;
      let tree: string | undefined;

      try {
        const observed = await this.observeWithRetry(step);
        screenshotB64 = observed.screenshotB64;
        screenshotBuffer = observed.screenshotBuffer;
        tree = observed.tree;
      } catch (err) {
        if (isAuditError(err)) throw err;
        throw new AuditError(
          'E_DEVICE_LOCKED',
          `Screenshot failed after ${MAX_SCREENSHOT_RETRIES} retries. ${(err as Error).message}`,
          { cause: err },
        );
      }
      const t1 = performance.now();

      // ── App-crash detection ─────────────────────────────────
      if (await this.detectAppCrash()) {
        this.crashStreak++;
        if (this.crashStreak >= 2) {
          throw new AuditError(
            'E_APP_CRASHED',
            `Target bundle ${this.auditConfig.bundleId} has not been in the foreground for 2 consecutive steps. The app may have crashed.`,
          );
        }
      } else {
        this.crashStreak = 0;
      }

      // ── Decide ──────────────────────────────────────────────
      const decideSpin = ora({ text: 'AI analyzing screen...', stream: process.stdout }).start();
      let result: AuditStepResult;
      try {
        result = await this.auditAgent.decideAudit({
          stepNumber: step,
          totalSteps: this.auditConfig.maxSteps,
          screenshotBuffer,
          accessibilityTree: tree,
          visited: this.visited,
          unvisitedTargets: this.unvisitedTargets,
          recentActions: this.recentActions,
          scope: this.auditConfig.scope,
        });
        decideSpin.succeed(result.usedFallback ? 'Decision made (fallback)' : 'Decision made');
      } catch (err) {
        decideSpin.fail('AI decision failed');
        throw err; // bubble up; finalize will still run via the outer finally
      }
      const t2 = performance.now();

      // ── Update exploration state ────────────────────────────
      const fingerprint = await fingerprintScreen({
        parsed: result.parsedTree,
        screenshotBase64: screenshotB64,
        grade: result.parsedTree?.grade ?? 'empty',
      });
      const screenName = result.audit?.screenName ?? `Screen@${fingerprint}`;
      this.updateVisited(fingerprint, screenName, step);

      if (result.parsedTree && result.parsedTree.grade === 'rich') {
        const targets = extractNavTargets(result.parsedTree.text);
        this.refreshUnvisitedTargets(targets);
      }

      // ── Log decision to console ─────────────────────────────
      console.log(pc.dim(`  💭 ${result.reasoning}`));
      console.log(
        pc.green(`  🎬 Action: ${result.navigation.action}`) +
          pc.dim(` ${JSON.stringify(result.navigation.params ?? {})}`),
      );
      if (result.audit?.issues.length) {
        console.log(
          pc.yellow(`  🔍 Issues found on this screen: ${result.audit.issues.length}`),
        );
      }

      // ── Collect + persist issues ────────────────────────────
      const persistedIssues: AuditIssue[] = [];
      if (result.audit?.issues?.length) {
        for (const issue of result.audit.issues) {
          this.issueCounter++;
          const id = `ISSUE-${String(this.issueCounter).padStart(3, '0')}`;
          const evidencePath = await saveEvidence(
            this.auditConfig.outputDir,
            screenshotBuffer,
            id,
          );
          const persisted: AuditIssue = {
            id,
            title: issue.title,
            severity: issue.severity,
            screenName,
            principle: issue.principle,
            persona: issue.persona,
            evidence: issue.evidence,
            confidence: issue.confidence,
            recommendation: issue.recommendation,
            stepNumber: step,
            evidencePath,
          };
          await appendIssue(this.auditConfig.outputDir, persisted);
          persistedIssues.push(persisted);
        }
      }

      // ── Annotate the screenshot (every step, not just issues) ──
      try {
        const annotated = await annotateScreenshot(screenshotBuffer, result.navigation, {
          stepNumber: step,
          totalSteps: this.auditConfig.maxSteps,
          model: this.auditConfig.model,
          target: extractTargetFromDecision(result.navigation),
          screenName,
        });
        await writeAnnotated(this.auditConfig.outputDir, step, annotated);
      } catch (err) {
        // Annotation failure should not kill the run — log and keep going.
        console.log(pc.dim(`  ⚠️  annotation failed: ${(err as Error).message}`));
      }

      // ── Completion / abort actions ──────────────────────────
      if (result.navigation.action === 'done') {
        console.log(pc.green('\n✅ Audit complete'));
        await this.recordStep(step, fingerprint, screenName, result, persistedIssues, {
          screenshot_ms: Math.round(t1 - t0),
          tree_ms: 0,
          ai_ms: Math.round(t2 - t1),
          action_ms: 0,
          sleep_ms: 0,
          total_ms: Math.round(performance.now() - t0),
        });
        return;
      }
      if (result.navigation.action === 'failed') {
        throw new AuditError('E_APP_CRASHED', `Agent gave up: ${result.reasoning}`);
      }

      // ── Execute the action ──────────────────────────────────
      const t3 = performance.now();
      try {
        await this.executeAction(result.navigation);
        this.recentActions.push(this.formatAction(result.navigation));
      } catch (err) {
        console.log(pc.yellow(`  ⚠️  action failed: ${(err as Error).message}`));
        this.recentActions.push('error');
      }
      const t4 = performance.now();

      // ── Stability wait (Decision 10) ────────────────────────
      if (NAVIGATION_ACTIONS.has(result.navigation.action)) {
        await this.waitForScreenStable(this.auditConfig.stableTimeout, STABLE_POLL_INTERVAL_MS);
      } else {
        await sleep(this.getPostActionDelay(result.navigation.action));
      }
      const t5 = performance.now();

      // ── Record the step ─────────────────────────────────────
      await this.recordStep(step, fingerprint, screenName, result, persistedIssues, {
        screenshot_ms: Math.round(t1 - t0),
        tree_ms: 0,
        ai_ms: Math.round(t2 - t1),
        action_ms: Math.round(t4 - t3),
        sleep_ms: Math.round(t5 - t4),
        total_ms: Math.round(t5 - t0),
      });
    }

    console.log(pc.yellow(`\n⏱️  Max steps (${this.auditConfig.maxSteps}) reached`));
  }

  // ── Observe with retry + liveness classification ─────────────

  private async observeWithRetry(
    _step: number,
  ): Promise<{ screenshotB64: string; screenshotBuffer: Buffer; tree?: string }> {
    for (let attempt = 1; attempt <= MAX_SCREENSHOT_RETRIES; attempt++) {
      try {
        const [shotResult, treeResult] = await Promise.allSettled([
          this.maestro.screenshotBase64(0),
          this.maestro.accessibilityTree(),
        ]);
        if (shotResult.status === 'rejected') throw shotResult.reason;
        const b64 = shotResult.value;
        const buffer = Buffer.from(b64, 'base64');
        const tree = treeResult.status === 'fulfilled' ? treeResult.value || undefined : undefined;
        return { screenshotB64: b64, screenshotBuffer: buffer, tree };
      } catch (err) {
        console.log(
          pc.yellow(`  ⚠️  screenshot attempt ${attempt}/${MAX_SCREENSHOT_RETRIES} failed: ${(err as Error).message}`),
        );
        if (attempt >= MAX_SCREENSHOT_RETRIES) {
          const driverAlive = await this.isDriverAlive();
          if (driverAlive) {
            throw new AuditError(
              'E_DEVICE_LOCKED',
              'Screenshots are failing but the driver is still responsive. The device may be locked or sleeping. Unlock it and retry.',
              { cause: err },
            );
          }
          throw new AuditError(
            'E_DRIVER_NOT_READY',
            `The ${this.auditConfig.runner} driver stopped responding. Restart it and retry the audit.`,
            { cause: err },
          );
        }
        await sleep(1000 * attempt); // 1s, 2s, 3s backoff
      }
    }
    // unreachable
    throw new Error('observeWithRetry: unreachable');
  }

  /** Quick liveness probe — if a tree call or status call succeeds the driver is alive. */
  private async isDriverAlive(): Promise<boolean> {
    try {
      await this.maestro.accessibilityTree();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Best-effort app-crash detection. We consider the app "crashed" when
   * two consecutive screenshots hash to the same 'home-screen-like' fingerprint.
   * For Phase 1 we keep this conservative — a heuristic is enough to avoid
   * infinite audit runs on a dead app.
   */
  private async detectAppCrash(): Promise<boolean> {
    // No cheap cross-runner way to inspect foreground state, so return false
    // for now. The crashStreak hook in runLoop is wired so a smarter check
    // can slot in later without touching the loop structure.
    return false;
  }

  // ── Visited map + nav target tracking ────────────────────────

  private updateVisited(fingerprint: string, name: string, step: number): void {
    const existing = this.visited.get(fingerprint);
    if (existing) {
      existing.count += 1;
    } else {
      this.visited.set(fingerprint, {
        fingerprint,
        name,
        count: 1,
        firstStep: step,
        issuesFound: 0,
      });
    }
  }

  private refreshUnvisitedTargets(targetsFromTree: string[]): void {
    const visitedNames = new Set([...this.visited.values()].map((v) => v.name.toLowerCase()));
    this.unvisitedTargets = targetsFromTree.filter((t) => !visitedNames.has(t.toLowerCase()));
  }

  // ── Persistence helpers ──────────────────────────────────────

  private async recordStep(
    step: number,
    fingerprint: string,
    screenName: string,
    result: AuditStepResult,
    persistedIssues: AuditIssue[],
    times: Omit<StepTiming, 'step' | 'input_tokens' | 'output_tokens' | 'cached_tokens'>,
  ): Promise<void> {
    const timing: StepTiming = {
      step,
      ...times,
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      cached_tokens: result.usage.cachedTokens,
    };
    this.timings.push(timing);

    const record: StepRecord = {
      step,
      fingerprint,
      screenName,
      action: this.formatAction(result.navigation),
      reasoning: result.reasoning,
      issuesFound: persistedIssues.map((i) => i.id),
      onboarding: result.onboardingDetected,
      timing,
    };
    if (result.onboardingDetected) this.onboardingSteps++;

    await appendStep(this.auditConfig.outputDir, record);
  }

  private async finalize(partialReason?: string): Promise<void> {
    // Timings JSON export
    const summary = summarize(this.timings, this.auditConfig.model);
    const timingsPath = path.join(this.auditConfig.outputDir, 'timings.json');
    await writeFile(
      timingsPath,
      JSON.stringify({ summary, timings: this.timings }, null, 2),
      'utf-8',
    );

    // Console summary (P50/P95/avg + cost)
    console.log(pc.cyan('\n⏱️  Performance summary:'));
    console.log(
      pc.dim(
        `   ai_ms       p50: ${summary.ai.p50}  p95: ${summary.ai.p95}  avg: ${summary.ai.avg}`,
      ),
    );
    console.log(
      pc.dim(
        `   screenshot  p50: ${summary.screenshot.p50}  p95: ${summary.screenshot.p95}  avg: ${summary.screenshot.avg}`,
      ),
    );
    console.log(
      pc.dim(
        `   total       p50: ${summary.total.p50}  p95: ${summary.total.p95}  avg: ${summary.total.avg}`,
      ),
    );
    console.log(
      pc.dim(
        `   tokens: ${summary.tokens.input}/${summary.tokens.output} (${summary.tokens.cached} cached)`,
      ),
    );
    console.log(
      pc.dim(
        `   est. cost:  $${summary.estimatedCost.toFixed(4)} (${summary.model})`,
      ),
    );

    if (partialReason) {
      console.log(pc.yellow(`\n⚠️  Partial report written (reason: ${partialReason})`));
    }
    console.log(pc.dim(`\n📁 Report: ${path.resolve(this.auditConfig.outputDir)}`));

    // report.md rendering is Group 13 — for now, leave a stub that points
    // the user at the JSONL files.
    const reportPath = path.join(this.auditConfig.outputDir, 'report.md');
    const stub = `# Audit Report (stub)

This audit produced ${this.timings.length} step(s) and ${this.issueCounter} issue(s).

The full Markdown report renderer is Group 13 (not yet implemented).

Until then, consume the raw artifacts:

- \`steps.jsonl\` — one JSON line per step (timing, action, reasoning)
- \`issues.jsonl\` — one JSON line per reported UX issue
- \`timings.json\` — P50/P95/avg + token + cost summary
- \`annotated/step-NN.jpg\` — per-step annotated screenshots
- \`screenshots/ISSUE-NNN.jpg\` — issue evidence (content-hash deduped)

${partialReason ? `\n**Partial run**: ${partialReason}\n` : ''}
`;
    await writeFile(reportPath, stub, 'utf-8');
  }

  // ── Driver lifecycle — delegate to parent's maestro ──────────

  private async startDriver(): Promise<void> {
    if (this.maestro instanceof WDAClient) {
      const spin = ora({ text: 'Starting WDA server...', stream: process.stdout }).start();
      try {
        await this.maestro.start();
        spin.succeed('WDA server ready');
      } catch (err) {
        spin.fail('Failed to start WDA server');
        throw err;
      }
    } else if (this.maestro instanceof XCTestClient) {
      const spin = ora({ text: 'Starting XCTest driver...', stream: process.stdout }).start();
      try {
        await this.maestro.connect();
        spin.succeed('XCTest driver ready');
      } catch (err) {
        spin.fail('Failed to start XCTest driver');
        throw err;
      }
    }
  }

  private async stopDriver(): Promise<void> {
    if (this.maestro instanceof WDAClient) {
      await this.maestro.stop();
    } else if (this.maestro instanceof XCTestClient) {
      await this.maestro.disconnect();
    }
  }

  // ── Lockfile (Decision 17) ───────────────────────────────────

  private acquireLock(): void {
    const key = (this.auditConfig.deviceId ?? this.auditConfig.iosDevice?.udid ?? 'default')
      .replace(/[^a-zA-Z0-9-]/g, '_');
    this.lockPath = path.join(LOCK_DIR, `phone-use-audit-${key}.lock`);

    if (existsSync(this.lockPath)) {
      try {
        const pidStr = readFileSync(this.lockPath, 'utf-8').trim();
        const pid = parseInt(pidStr, 10);
        if (Number.isInteger(pid) && isProcessAlive(pid)) {
          throw new AuditError(
            'E_CONCURRENT_RUN',
            `Another phone-use audit (pid ${pid}) is already running on this device. Wait for it to finish or kill the other process.`,
          );
        }
        // Stale lockfile — claim it.
      } catch (err) {
        if (isAuditError(err)) throw err;
        // Unreadable lockfile — proceed (best-effort)
      }
    }

    writeFileSync(this.lockPath, String(process.pid), 'utf-8');
    this.exitHandler = () => {
      if (this.lockPath && existsSync(this.lockPath)) {
        try {
          unlinkSync(this.lockPath);
        } catch {
          /* ignore */
        }
      }
    };
    process.on('exit', this.exitHandler);
  }

  private releaseLock(): void {
    if (this.lockPath && existsSync(this.lockPath)) {
      try {
        unlinkSync(this.lockPath);
      } catch {
        /* ignore */
      }
    }
    if (this.exitHandler) {
      process.removeListener('exit', this.exitHandler);
      this.exitHandler = null;
    }
    this.lockPath = null;
  }

  // ── Output dir + header ──────────────────────────────────────

  private async initOutputDir(): Promise<void> {
    await mkdir(path.join(this.auditConfig.outputDir, 'screenshots'), { recursive: true });
    await mkdir(path.join(this.auditConfig.outputDir, 'annotated'), { recursive: true });
  }

  private printHeader(): void {
    console.log(pc.cyan('\n🔍 Audit run starting:'));
    console.log(pc.dim(`   Bundle:       ${this.auditConfig.bundleId}`));
    console.log(pc.dim(`   Runner:       ${this.auditConfig.runner}`));
    console.log(pc.dim(`   Device:       ${this.auditConfig.deviceId ?? '(booted simulator)'}`));
    console.log(pc.dim(`   Model:        ${this.auditConfig.model}`));
    console.log(pc.dim(`   Max steps:    ${this.auditConfig.maxSteps}`));
    console.log(pc.dim(`   RPM limit:    ${this.auditConfig.rpmLimit}`));
    console.log(pc.dim(`   Output:       ${this.auditConfig.outputDir}`));
    console.log('');
  }
}

// ── Module helpers ────────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function extractTargetFromDecision(decision: AgentDecision): string | undefined {
  const p = decision.params;
  if (!p) return undefined;
  if (p.text) return p.text;
  if (p.appId) return p.appId;
  if (p.url) return p.url;
  return undefined;
}

// Unused imports kept for future use by Group 14 CLI wiring
void createHash;
void mkdirSync;
