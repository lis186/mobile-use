/**
 * TaskExecutor - Orchestrates the AI agent and Maestro client
 */

import { createHash } from 'node:crypto';
import { exec } from 'node:child_process';
import ora, { type Ora } from 'ora';
import pc from 'picocolors';
import { MaestroClient } from './maestro.js';
import { WDAClient } from './wda.js';
import { XCTestClient } from './xctest.js';
import { TaskAgent } from './agent.js';
import type { TaskConfig, AgentDecision, ExecutionResult } from './types.js';
import type { LiveViewer } from './core/live-viewer.js';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSpinner(text: string): Ora {
  return ora({
    text,
    stream: process.stdout,
    isEnabled: true,
    isSilent: false,
  });
}

/**
 * Build the low-level driver client for a given TaskConfig.
 * Shared with AuditExecutor so the runner-selection branch only lives once.
 */
export function buildDriverFromTaskConfig(
  config: TaskConfig,
): MaestroClient | WDAClient | XCTestClient {
  if (config.runner === 'xctest') {
    return new XCTestClient({
      simulatorId: config.deviceId ?? config.iosDevice?.udid ?? 'booted',
      xctestrunPath: config.iosDevice?.appFile,
      port: config.iosDevice?.driverPort ?? 22087,
      bundleId: config.bundleId,
    });
  }
  if (config.runner === 'wda' && config.iosDevice) {
    return new WDAClient({
      udid: config.iosDevice.udid,
      teamId: config.iosDevice.teamId ?? '',
      bundleId: config.bundleId,
      port: config.iosDevice.driverPort ?? 8100,
    });
  }
  return new MaestroClient({
    bundleId: config.bundleId,
    deviceId: config.deviceId,
    iosDevice: config.iosDevice,
    runner: config.runner,
  });
}

export class TaskExecutor {
  // Protected so AuditExecutor (Phase 1) can reuse the driver lifecycle,
  // stability-wait loop, and executeAction dispatch without duplicating code.
  protected maestro: MaestroClient | WDAClient | XCTestClient;
  protected agent: TaskAgent;
  private config: TaskConfig;
  private liveViewer: LiveViewer | null = null;

  constructor(config: TaskConfig, apiKey: string, provider: 'google' | 'openai' = 'google') {
    this.config = config;
    this.maestro = buildDriverFromTaskConfig(config);
    this.agent = new TaskAgent(apiKey, config.model, provider);
  }

  async execute(): Promise<ExecutionResult> {
    console.log(pc.cyan('\n🎯 Task: ') + pc.white(this.config.task));
    if (this.config.bundleId) {
      console.log(pc.cyan('📱 App: ') + pc.white(this.config.bundleId));
    } else {
      console.log(pc.cyan('📱 App: ') + pc.dim('(foreground app)'));
    }
    if (this.config.iosDevice) {
      console.log(pc.cyan('📲 iOS Device: ') + pc.white(this.config.iosDevice.udid));
      if (this.config.runner) {
        console.log(pc.cyan('🔧 Runner: ') + pc.white(this.config.runner));
      }
      if (this.config.iosDevice.appFile) {
        console.log(pc.cyan('📦 App File: ') + pc.white(this.config.iosDevice.appFile));
      }
    } else if (this.config.deviceId) {
      console.log(pc.cyan('📲 Device: ') + pc.white(this.config.deviceId));
    }
    console.log(pc.cyan('🔄 Max Steps: ') + pc.white(String(this.config.maxSteps)));
    console.log('');

    // Start live viewer if --live is enabled
    if (this.config.live) {
      const { LiveViewer: LV } = await import('./core/live-viewer.js');
      this.liveViewer = new LV(this.config.livePort ?? 7330);
      this.liveViewer.setTaskName(this.config.task);
      try {
        await this.liveViewer.start();
        console.log(pc.cyan('👁  Live viewer: ') + pc.white(this.liveViewer.url));
        if (process.platform === 'darwin') {
          exec(`open ${this.liveViewer.url}`);
        }
      } catch (error) {
        const err = error as Error;
        console.log(pc.yellow(`  ⚠️ Live viewer failed to start: ${err.message}`));
        this.liveViewer = null;
      }
      console.log('');
    }

    // Start driver lifecycle (WDA or XCTest)
    if (this.maestro instanceof WDAClient) {
      const wdaSpinner = createSpinner('Starting WDA server...').start();
      try {
        await this.maestro.start();
        wdaSpinner.succeed('WDA server ready');
      } catch (error) {
        wdaSpinner.fail('Failed to start WDA server');
        const err = error as Error;
        return { success: false, reason: err.message, steps: 0 };
      }
    } else if (this.maestro instanceof XCTestClient) {
      const xctestSpinner = createSpinner('Starting XCTest driver...').start();
      try {
        await this.maestro.connect();
        xctestSpinner.succeed('XCTest driver ready');
      } catch (error) {
        xctestSpinner.fail('Failed to start XCTest driver');
        const err = error as Error;
        return { success: false, reason: err.message, steps: 0 };
      }
    }

    const actionHistory: string[] = [];

    try {
      if (this.maestro.hasBundleId()) {
        const launchSpinner = createSpinner('Launching app...').start();
        try {
          await this.maestro.launch();
          launchSpinner.succeed('App launched');
          actionHistory.push('launched');
          await this.waitForScreenStable();
        } catch (error) {
          launchSpinner.fail('Failed to launch app');
          const err = error as Error;
          return { success: false, reason: err.message, steps: 0 };
        }
      } else {
        console.log(pc.dim('Skipping app launch (working with foreground app)'));
        actionHistory.push('ready');
        await sleep(1000);
      }
      let steps = 0;

      // Task execution loop
      while (steps < this.config.maxSteps) {
        steps++;
        console.log(pc.dim(`\n${'─'.repeat(40)}`));
        console.log(pc.bold(`Step ${steps}/${this.config.maxSteps}`));

        const observeSpinner = createSpinner('Capturing screen...').start();
        let screenshot: string;
        let accessibilityTree: string | undefined;

        try {
          // Screenshot and accessibility tree are independent — fetch in parallel
          const [screenshotResult, treeResult] = await Promise.allSettled([
            this.maestro.screenshotBase64(steps),
            this.maestro.accessibilityTree(),
          ]);

          if (screenshotResult.status === 'rejected') {
            throw screenshotResult.reason as Error;
          }
          screenshot = screenshotResult.value;
          observeSpinner.succeed('Screen captured');

          if (treeResult.status === 'fulfilled') {
            accessibilityTree = treeResult.value || undefined;
          }
          // tree failure is fail-open: continue with screenshot-only
        } catch (error) {
          observeSpinner.fail('Screenshot failed');
          const err = error as Error;
          console.log(pc.yellow(`  ⚠️ ${err.message}`));
          await sleep(2000);
          continue;
        }

        // Decide
        const thinkSpinner = createSpinner('AI thinking...').start();
        let decision: AgentDecision;

        try {
          decision = await this.agent.decide(screenshot, this.config.task, {
            stepNumber: steps,
            maxSteps: this.config.maxSteps,
            actionHistory,
            accessibilityTree,
            language: this.config.language,
            successCriteria: this.config.successCriteria,
            constraints: this.config.constraints,
          });
          thinkSpinner.succeed('Decision made');
        } catch (error) {
          thinkSpinner.fail('AI decision failed');
          const err = error as Error;
          console.log(pc.yellow(`  ⚠️ ${err.message}`));
          await sleep(2000);
          continue;
        }

        console.log(pc.dim(`  💭 ${decision.reasoning}`));
        console.log(pc.blue(`  📊 Progress: ${decision.progress}%`));
        console.log(
          pc.green(`  🎬 Action: ${decision.action}`) +
            (decision.params ? pc.dim(` ${JSON.stringify(decision.params)}`) : '')
        );

        // Push to live viewer (fire-and-forget, don't block the loop)
        if (this.liveViewer) {
          this.liveViewer.pushStep({
            step: steps,
            maxSteps: this.config.maxSteps,
            screenshotBase64: screenshot,
            action: decision.action,
            reasoning: decision.reasoning,
            progress: decision.progress,
            params: decision.params as Record<string, unknown> | undefined,
          }).catch(() => { /* ignore push errors */ });
        }

        // Handle completion
        if (decision.action === 'done') {
          console.log(pc.green('\n✅ Task completed successfully!'));
          const result: ExecutionResult = { success: true, reason: decision.reasoning, steps };
          this.liveViewer?.pushDone(result);
          return result;
        }

        if (decision.action === 'failed') {
          console.log(pc.red('\n❌ Task failed: ') + decision.reasoning);
          const result: ExecutionResult = { success: false, reason: decision.reasoning, steps };
          this.liveViewer?.pushDone(result);
          return result;
        }

        // Execute action
        try {
          await this.executeAction(decision);
          const actionStr = this.formatAction(decision);
          actionHistory.push(actionStr);
        } catch (error) {
          const err = error as Error;
          console.log(pc.yellow(`  ⚠️ Action failed: ${err.message}`));
          actionHistory.push('error');
        }

        await sleep(this.getPostActionDelay(decision.action));
      }

      console.log(pc.yellow('\n⏱️ Max steps reached'));
      const result: ExecutionResult = { success: false, reason: 'Timeout - max steps exceeded', steps };
      this.liveViewer?.pushDone(result);
      return result;
    } finally {
      // Clean up live viewer
      if (this.liveViewer) {
        await this.liveViewer.stop();
        this.liveViewer = null;
      }
      // Clean up driver processes
      if (this.maestro instanceof WDAClient) {
        await this.maestro.stop();
      } else if (this.maestro instanceof XCTestClient) {
        await this.maestro.disconnect();
      }
    }
  }

  protected async waitForScreenStable(maxMs = 5000, intervalMs = 500): Promise<void> {
    const deadline = Date.now() + maxMs;
    let prevHash: string | null = null;
    let stableCount = 0;

    while (Date.now() < deadline) {
      let current: string;
      try {
        current = await this.maestro.screenshotBase64(0);
      } catch {
        await sleep(intervalMs);
        continue;
      }

      const hash = createHash('md5').update(current).digest('hex');
      if (hash === prevHash) {
        stableCount++;
        if (stableCount >= 2) return; // stable for 2 consecutive checks
      } else {
        stableCount = 0;
      }
      prevHash = hash;
      await sleep(intervalMs);
    }
    // timed out — proceed anyway
  }

  protected getPostActionDelay(action: string): number {
    switch (action) {
      case 'launchApp':
      case 'stopApp':
        return 2000;
      case 'scroll':
      case 'swipe':
        return 500;
      case 'inputText':
        return 300;
      case 'wait':
        return 0; // wait action handles its own delay
      default:
        return 300;
    }
  }

  protected async executeAction(decision: AgentDecision): Promise<void> {
    const params = decision.params || {};

    switch (decision.action) {
      case 'tap':
        await this.maestro.tap(params.x ?? 50, params.y ?? 50);
        break;

      case 'tapText':
        await this.maestro.tapText(params.text ?? '');
        break;

      case 'doubleTap':
        await this.maestro.doubleTap(params.x ?? 50, params.y ?? 50);
        break;

      case 'longPress':
        if (params.text) {
          await this.maestro.longPressText(params.text);
        } else {
          await this.maestro.longPress(params.x ?? 50, params.y ?? 50);
        }
        break;

      case 'inputText':
        await this.maestro.inputText(params.text ?? '');
        break;

      case 'eraseText':
        await this.maestro.eraseText(params.chars ?? 50);
        break;

      case 'scroll':
        await this.maestro.scroll();
        break;

      case 'swipe':
        await this.maestro.swipe(params.startX ?? 50, params.startY ?? 50, params.endX ?? 50, params.endY ?? 20);
        break;

      case 'back':
        try {
          await this.maestro.back();
        } catch {
          // Fallback to iOS gesture
          await this.maestro.iosBackGesture();
        }
        break;

      case 'hideKeyboard':
        await this.maestro.hideKeyboard();
        break;

      case 'openLink':
        await this.maestro.openLink(params.url ?? '');
        break;

      case 'pressKey':
        await this.maestro.pressKey(params.key ?? 'enter');
        break;

      case 'wait':
        await this.maestro.waitForAnimation(params.timeout ?? 3000);
        break;

      case 'launchApp':
        if (params.appId) {
          await this.maestro.launchApp(params.appId);
        }
        break;

      case 'stopApp':
        if (params.appId) {
          await this.maestro.stopApp(params.appId);
        }
        break;

      default:
        console.log(pc.yellow(`  Unknown action: ${decision.action}`));
    }
  }

  protected formatAction(decision: AgentDecision): string {
    const params = decision.params;
    if (!params) return decision.action;

    switch (decision.action) {
      case 'tap':
      case 'doubleTap':
      case 'longPress':
        return `${decision.action}(${params.x},${params.y})`;
      case 'tapText':
      case 'inputText':
        return `${decision.action}("${params.text?.slice(0, 20)}")`;
      case 'swipe':
        return `swipe(${params.startX},${params.startY}->${params.endX},${params.endY})`;
      case 'launchApp':
      case 'stopApp':
        return `${decision.action}("${params.appId}")`;
      default:
        return decision.action;
    }
  }
}
