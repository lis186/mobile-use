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

import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import ora from 'ora';
import pc from 'picocolors';
import { TaskExecutor, buildDriverFromTaskConfig, sleep } from './executor.js';
import { AuditAgent, type AuditStepResult } from './audit-agent.js';
import { AuditError, isAuditError, type AuditErrorCode } from './errors/audit-errors.js';
import { WDAClient } from './wda.js';
import { XCTestClient } from './xctest.js';
import { fingerprintScreen } from './core/screen-fingerprint.js';
import { extractNavTargets, extractRootAppId } from './core/tree-parser.js';
import { appendStep, appendIssue } from './core/jsonl-writer.js';
import { saveEvidence } from './core/evidence.js';
import { annotateScreenshot, writeAnnotated, firstParamText } from './core/annotate.js';
import { summarize } from './core/step-timing.js';
import { finalizeReport } from './audit-report.js';
import type { LiveViewer } from './core/live-viewer.js';
import type {
  AuditConfig,
  TaskConfig,
  StepTiming,
  VisitedScreen,
  AuditIssue,
  StepRecord,
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
const MAX_CONSECUTIVE_SWIPES = 4;
const MAX_OVEREXPLORED_VISITS = 4;

export type AuditPartialReason = AuditErrorCode | 'E_UNEXPECTED';

export interface AuditRunResult {
  success: boolean;
  outputDir: string;
  stepsTotal: number;
  issuesFound: number;
  partialReason?: AuditPartialReason;
}

export class AuditExecutor extends TaskExecutor {
  private readonly auditConfig: AuditConfig;
  private readonly auditAgent: AuditAgent;
  private readonly visited = new Map<string, VisitedScreen>();
  private unvisitedTargets: string[] = [];
  private readonly recentActions: string[] = [];
  private consecutiveSwipes = 0;
  private readonly timings: StepTiming[] = [];
  private issueCounter = 0;
  private lockPath: string | null = null;
  private exitHandler: (() => void) | null = null;
  private onboardingSteps = 0;
  private crashStreak = 0;
  private startedAt: Date = new Date();
  private cancelRequested = false;
  private auditLiveViewer: LiveViewer | null = null;
  private expectedAppLabel: string | null = null;
  // Per-fingerprint relaunch tracking: each overexplored fingerprint gets exactly one
  // relaunch attempt. Using a Set instead of a global counter prevents a single screen
  // with multiple fingerprints (different scroll states) from exhausting the budget
  // before other stuck screens can escape.
  private readonly relaunched = new Set<string>();

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
   * Request a graceful cancel from outside the loop (e.g. SIGINT handler in
   * `src/index.ts`). The loop finishes its current step, then throws
   * `E_USER_ABORTED` so the outer `try/finally` still runs `finalize()` and
   * a partial report is written. Idempotent — subsequent calls no-op.
   */
  cancel(): void {
    if (this.cancelRequested) return;
    this.cancelRequested = true;
    console.log(pc.yellow('\n⏸  Cancel requested — finishing current step, then writing a partial report...'));
  }

  /**
   * Main audit entry point. Handles lifecycle, lock, loop, finalize.
   * Does NOT call the parent's execute() — this is the audit loop body.
   */
  async executeAudit(): Promise<AuditRunResult> {
    this.startedAt = new Date();
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

    // Start live viewer if --live is enabled (opt-in, zero overhead otherwise)
    if (this.auditConfig.live) {
      try {
        const { LiveViewer: LV } = await import('./core/live-viewer.js');
        this.auditLiveViewer = new LV(this.auditConfig.livePort ?? 7330);
        this.auditLiveViewer.setTaskName(`audit:${this.auditConfig.bundleId}`);
        await this.auditLiveViewer.start();
        console.log(pc.cyan('👁  Live viewer: ') + pc.white(this.auditLiveViewer.url));
        if (process.platform === 'darwin') {
          const { exec } = await import('node:child_process');
          exec(`open ${this.auditLiveViewer.url}`);
        }
      } catch {
        console.log(pc.yellow('  ⚠️ Live viewer failed to start — continuing without it'));
        this.auditLiveViewer = null;
      }
    }

    let partialReason: AuditPartialReason | undefined;
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
    while (step < this.auditConfig.maxSteps && !this.cancelRequested) {
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
      if (this.detectAppCrash(tree)) {
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

      // ── Scope guard — detect cross-app drift ───────────────
      // XCTest's /viewHierarchy filters by appIds — if the target app isn't
      // in the foreground, the tree comes back empty (caught by detectAppCrash).
      // WDA returns the full tree regardless of which app is in front, so we
      // need an explicit check. extractRootAppId returns the display name
      // (e.g. "Settings"), not the bundle ID, so we store the expected display
      // name from the first non-empty tree and compare against that.
      if (tree && this.auditConfig.runner === 'wda') {
        const treeAppId = extractRootAppId(tree);
        if (treeAppId) {
          if (!this.expectedAppLabel) {
            // First successful tree — record the display name as baseline
            this.expectedAppLabel = treeAppId;
          } else if (treeAppId !== this.expectedAppLabel) {
            console.log(
              pc.yellow(`  ⚠️  Scope drift: in "${treeAppId}", expected "${this.expectedAppLabel}" — going back`),
            );
            try {
              await this.executeAction({ action: 'back', params: {}, reasoning: 'scope guard', progress: 0 });
            } catch {
              try {
                await this.executeAction({ action: 'launchApp', params: { appId: this.auditConfig.bundleId }, reasoning: 'scope guard relaunch', progress: 0 });
              } catch { /* best effort */ }
            }
            this.recentActions.push('back (scope guard)');
            continue;
          }
        }
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
      const screenName = result.screenName?.trim() || `Screen@${fingerprint}`;
      this.updateVisited(fingerprint, screenName, step);

      if (result.parsedTree && result.parsedTree.grade === 'rich') {
        const targets = extractNavTargets(result.parsedTree.text);
        this.refreshUnvisitedTargets(targets);

        // ── P5: Step budget estimation (step 1 only) ──────────
        if (step === 1 && this.unvisitedTargets.length > 0) {
          const sectionCount = this.unvisitedTargets.length;
          const estimatedSteps = sectionCount * 3;
          const pct = Math.min(100, Math.round((this.auditConfig.maxSteps / estimatedSteps) * 100));
          console.log(pc.cyan(`\n  📊 Coverage estimate: ${sectionCount} sections × 3 steps ≈ ${estimatedSteps} steps needed`));
          console.log(pc.cyan(`     With --max-steps ${this.auditConfig.maxSteps}: ~${pct}% coverage`));
          if (pct < 60) {
            console.log(pc.yellow(`     ⚠️  Consider --max-steps ${estimatedSteps} for full coverage`));
          }
        }
      } else if (step === 1 && result.parsedTree) {
        console.log(pc.cyan(`\n  📊 Coverage estimate: uncertain (${result.parsedTree.grade} accessibility tree)`));
      }

      // ── Log decision to console ─────────────────────────────
      console.log(pc.dim(`  💭 ${result.reasoning}`));
      console.log(
        pc.green(`  🎬 Action: ${result.navigation.action}`) +
          pc.dim(` ${JSON.stringify(result.navigation.params ?? {})}`),
      );
      // ── Collect + persist issues in parallel ────────────────
      let persistedIssues: AuditIssue[] = [];
      const filteredIssues = result.audit?.issues?.filter(
        (issue) => !isSpecimenScreenIssue(screenName, issue),
      );
      const dropped = (result.audit?.issues?.length ?? 0) - (filteredIssues?.length ?? 0);
      if (filteredIssues?.length || dropped) {
        const parts: string[] = [];
        if (filteredIssues?.length) parts.push(`${filteredIssues.length} issues`);
        if (dropped) parts.push(`${dropped} specimen-screen filtered`);
        console.log(pc.yellow(`  🔍 ${parts.join(', ')}`));
      }
      if (filteredIssues?.length) {
        const withIds = filteredIssues.map((issue) => {
          this.issueCounter++;
          return {
            issue,
            id: `ISSUE-${String(this.issueCounter).padStart(3, '0')}`,
          };
        });
        persistedIssues = await Promise.all(
          withIds.map(async ({ issue, id }) => {
            const evidencePath = await saveEvidence(this.auditConfig.outputDir, screenshotBuffer, id);
            const persisted: AuditIssue = {
              id,
              title: issue.title,
              severity: issue.severity,
              screenName,
              principle: issue.principle,
              persona: issue.persona,
              evidence: issue.evidence,
              cognitiveImpact: issue.cognitiveImpact,
              confidence: issue.confidence,
              recommendation: issue.recommendation,
              stepNumber: step,
              evidencePath,
            };
            await appendIssue(this.auditConfig.outputDir, persisted);
            return persisted;
          }),
        );
      }

      // ── Annotate the screenshot (every step, not just issues) ──
      try {
        const annotated = await annotateScreenshot(screenshotBuffer, result.navigation, {
          stepNumber: step,
          totalSteps: this.auditConfig.maxSteps,
          model: this.auditConfig.model,
          target: firstParamText(result.navigation) ?? undefined,
          screenName,
        });
        await writeAnnotated(this.auditConfig.outputDir, step, annotated);

        // Push to live viewer (fire-and-forget)
        if (this.auditLiveViewer) {
          this.auditLiveViewer.pushStep({
            step,
            maxSteps: this.auditConfig.maxSteps,
            screenshotBase64: screenshotB64,
            action: result.navigation.action,
            reasoning: result.reasoning,
            progress: result.progress,
            params: result.navigation.params as Record<string, unknown> | undefined,
          }).catch(() => { /* ignore push errors */ });
        }
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

      // ── P4: Overexplored screen → escalate to relaunch ──────
      // If the same fingerprint has been seen ≥ MAX_OVEREXPLORED_VISITS times,
      // back() alone won't escape the subtree. Relaunch the app to return to
      // the home state and resume exploration from a clean starting point.
      // The visited map is preserved so already-explored screens are not revisited.
      const visitCount = this.visited.get(fingerprint)?.count ?? 1;
      if (visitCount >= MAX_OVEREXPLORED_VISITS && !this.relaunched.has(fingerprint)) {
        this.relaunched.add(fingerprint);
        console.log(
          pc.yellow(
            `  ⚠️  Stuck: screen seen ${visitCount}× — relaunching app`,
          ),
        );
        try {
          await this.executeAction({
            action: 'launchApp',
            params: { appId: this.auditConfig.bundleId },
            reasoning: `stuck escape: screen seen ${visitCount} times`,
            progress: 0,
          });
          await this.waitForScreenStable(this.auditConfig.stableTimeout, STABLE_POLL_INTERVAL_MS);
        } catch (err) {
          console.log(pc.yellow(`  ⚠️  Relaunch failed: ${(err as Error).message}`));
        }
        this.recentActions.push(
          `STUCK: relaunched app after same screen seen ${visitCount}× — resuming exploration from home`,
        );
        this.consecutiveSwipes = 0;
        continue;
      }

      // ── Execute the action ──────────────────────────────────
      const t3 = performance.now();
      const isSwipe = result.navigation.action === 'swipe' || result.navigation.action === 'scroll';
      try {
        await this.executeAction(result.navigation);
        this.recentActions.push(this.formatAction(result.navigation));
      } catch (err) {
        console.log(pc.yellow(`  ⚠️  action failed: ${(err as Error).message}`));
        this.recentActions.push('error');
      }

      // ── Stuck detection: escape paginated content ──────────
      if (isSwipe) {
        this.consecutiveSwipes++;
        if (this.consecutiveSwipes >= MAX_CONSECUTIVE_SWIPES) {
          console.log(pc.yellow(`  ⚠️  Stuck: ${this.consecutiveSwipes} consecutive swipes — forcing back`));
          try {
            await this.executeAction({ action: 'back', params: {}, reasoning: 'stuck escape', progress: 0 });
          } catch { /* best effort */ }
          this.recentActions.push(`STUCK: forced back after ${this.consecutiveSwipes} consecutive swipes in paginated content — explore a different section`);
          this.consecutiveSwipes = 0;
        }
      } else {
        this.consecutiveSwipes = 0;
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

      // ── Token budget enforcement ────────────────────────────
      const totalInput = this.timings.reduce((sum, t) => sum + t.input_tokens, 0);
      if (totalInput > this.auditConfig.tokenBudget) {
        throw new AuditError(
          'E_BUDGET_EXCEEDED',
          `Total input tokens (${totalInput.toLocaleString()}) exceeded --token-budget (${this.auditConfig.tokenBudget.toLocaleString()}) after step ${step}. Partial report has been written.`,
        );
      }
    }

    if (this.cancelRequested) {
      throw new AuditError(
        'E_USER_ABORTED',
        'Audit was cancelled by the user (SIGINT) before completion. A partial report has been written.',
      );
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
   * Best-effort app-crash detection. XCTest's viewHierarchy is filtered by
   * the target bundleId. When the app isn't in the foreground (crashed,
   * bounced to SpringBoard, or left via external link), the response contains
   * no Application element — the tree comes back empty or undefined.
   *
   * We require 2 consecutive empty trees before declaring a crash to avoid
   * false positives from transient blank-screen transitions (e.g. app launch
   * splash, system dialog overlay that briefly hides the app).
   */
  private detectAppCrash(tree: string | undefined): boolean {
    // A legitimate in-foreground tree has at minimum 10+ chars of AX data
    // (Application root, at least one child). Empty / undefined = target app
    // likely not in foreground.
    return !tree || tree.trim().length < 10;
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

  private async finalize(partialReason?: AuditPartialReason): Promise<void> {
    // timings.json MUST be written before finalizeReport() reads it, so
    // these two writes are sequenced (small serial cost, large clarity win).
    const summary = summarize(this.timings, this.auditConfig.model);
    const timingsPath = path.join(this.auditConfig.outputDir, 'timings.json');
    await writeFile(
      timingsPath,
      JSON.stringify({ summary, timings: this.timings }, null, 2),
      'utf-8',
    );

    await finalizeReport(this.auditConfig.outputDir, {
      bundleId: this.auditConfig.bundleId,
      runner: this.auditConfig.runner,
      deviceInfo: this.auditConfig.deviceId ?? '(booted simulator)',
      model: this.auditConfig.model,
      startedAt: this.startedAt,
      endedAt: new Date(),
      maxSteps: this.auditConfig.maxSteps,
      partialReason,
    });

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

    // Shut down live viewer
    if (this.auditLiveViewer) {
      await this.auditLiveViewer.stop();
      this.auditLiveViewer = null;
    }
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

    // Atomic lock: O_CREAT|O_EXCL ('wx') fails with EEXIST if another
    // process already created the file — no read-then-write race window.
    try {
      writeFileSync(this.lockPath, String(process.pid), { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        // Lock file exists — check if the holder is still alive.
        try {
          const pidStr = readFileSync(this.lockPath, 'utf-8').trim();
          const pid = parseInt(pidStr, 10);
          if (Number.isInteger(pid) && isProcessAlive(pid)) {
            throw new AuditError(
              'E_CONCURRENT_RUN',
              `Another phone-use audit (pid ${pid}) is already running on this device. Wait for it to finish or kill the other process.`,
            );
          }
        } catch (readErr) {
          if (isAuditError(readErr)) throw readErr;
          // Unreadable / disappeared between check — fall through to reclaim.
        }
        // Stale lock from a dead process — overwrite it.
        writeFileSync(this.lockPath, String(process.pid), 'utf-8');
      } else {
        // Some other I/O error (permissions, disk full) — best-effort continue.
      }
    }

    this.exitHandler = () => {
      this.unlinkLockSilently();
    };
    process.on('exit', this.exitHandler);
  }

  private releaseLock(): void {
    this.unlinkLockSilently();
    if (this.exitHandler) {
      process.removeListener('exit', this.exitHandler);
      this.exitHandler = null;
    }
    this.lockPath = null;
  }

  /** Delete the lockfile, tolerating ENOENT and other benign errors. */
  private unlinkLockSilently(): void {
    if (!this.lockPath) return;
    try {
      unlinkSync(this.lockPath);
    } catch {
      /* ENOENT / EACCES / race — lockfile is gone or we can't clean up; either way, move on. */
    }
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

const SPECIMEN_SCREEN_PATTERN = /font|字體|typeface|字型|specimen|preview.*font|font.*preview/i;
const SPECIMEN_PRINCIPLE_PATTERN = /contrast|readability|legibility/i;

/** Code-level safety net: drop contrast/readability issues on font specimen screens. */
function isSpecimenScreenIssue(
  screenName: string,
  issue: { title: string; principle: string },
): boolean {
  if (!SPECIMEN_SCREEN_PATTERN.test(screenName)) return false;
  return SPECIMEN_PRINCIPLE_PATTERN.test(issue.principle) ||
    SPECIMEN_PRINCIPLE_PATTERN.test(issue.title);
}


