/**
 * Mobile Use - AI-powered mobile task automation
 * Execute tasks on mobile apps using natural language
 */

import 'dotenv/config';
import * as path from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import ora, { type Ora } from 'ora';
import { TaskExecutor } from './executor.js';
import {
  ensureMaestroInstalled,
  isMaestroInstalled,
  ensureMaestroIosDeviceInstalled,
  isMaestroIosDeviceInstalled,
} from './utils/install-maestro.js';
import type { TaskConfig, RunnerType, AuditConfig } from './types.js';
import { inferProvider, getApiConfig as getApiConfigBase } from './cli/api-config.js';
import { AuditError, isAuditError } from './errors/audit-errors.js';

const DEFAULT_MAX_STEPS = 100;
const DEFAULT_AUDIT_MAX_STEPS = 25;

// Handle graceful shutdown
let isShuttingDown = false;

/**
 * When an audit command is active, the audit action handler registers a
 * cancel callback here. The global SIGINT handler below invokes it and
 * then waits one short tick so the executor's current step can unwind
 * and write a partial report before the process exits.
 *
 * Null when no audit is active (or before `runAuditCommand` has
 * constructed its executor) — in that case SIGINT falls through to the
 * original "exit 0 immediately" behaviour used by `run` and other
 * commands.
 */
let auditCancelCallback: (() => void) | null = null;

function setupSignalHandlers(): void {
  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      process.stderr.write('\n\nForce quitting...\n');
      process.exit(1);
    }
    isShuttingDown = true;
    process.stderr.write(`\n\n${signal} received. Shutting down gracefully...\n`);

    // If an audit is running, tell it to cancel and let the main
    // `await runAuditCommand(...)` unwind naturally. The audit command's
    // own try/finally then runs `finalize()` and prints the partial
    // report summary before the normal exit path runs.
    if (auditCancelCallback) {
      try {
        auditCancelCallback();
      } catch {
        // best-effort — never block shutdown on a callback crash
      }
      // Do NOT process.exit() here: the audit action handler will call
      // process.exit() itself once executeAudit() unwinds. The second
      // Ctrl+C (handled by `isShuttingDown` above) still works as a
      // force-quit if the user gets impatient.
      return;
    }

    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
}

setupSignalHandlers();

function createSpinner(text: string): Ora {
  return ora({
    text,
    stream: process.stdout,
    isEnabled: true,
    isSilent: false,
  });
}

/** CLI wrapper for getApiConfig — adds pretty error messages and exits on failure */
function getApiConfig(model?: string): { apiKey: string; provider: 'google' | 'openai'; defaultModel: string } {
  // Check for model-specific provider mismatch first
  if (model) {
    const inferred = inferProvider(model);
    if (inferred === 'openai' && !process.env.OPENAI_API_KEY) {
      console.error(pc.red(`\n❌ Error: Model "${model}" requires OPENAI_API_KEY`));
      process.exit(1);
    }
    if (inferred === 'google' && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      console.error(pc.red(`\n❌ Error: Model "${model}" requires GOOGLE_GENERATIVE_AI_API_KEY`));
      process.exit(1);
    }
  }

  try {
    return getApiConfigBase(model);
  } catch {
    console.error(pc.red('\n❌ Error: API key not found'));
    console.log(pc.dim('\nSet one of the environment variables:'));
    console.log(pc.dim('  GOOGLE_GENERATIVE_AI_API_KEY=your_key  (recommended, free tier available)'));
    console.log(pc.dim('  OPENAI_API_KEY=your_key'));
    console.log(pc.dim('\nGet your Google AI key from: https://aistudio.google.com/apikey'));
    console.log(pc.dim('Get your OpenAI key from: https://platform.openai.com/api-keys\n'));
    process.exit(1);
  }
}

// Create CLI program
const program = new Command();

program.name('phone-use').description('AI-powered mobile task automation using Maestro and OpenAI').version('1.0.0').enablePositionalOptions();

program
  .command('run')
  .description('Execute a task on a mobile app')
  .argument('[bundleId]', 'App bundle ID (e.g., com.example.app)')
  .argument('[task]', 'Task to execute in natural language')
  .option('-t, --task <task>', 'Task to execute (use when running without bundleId)')
  .option('-m, --max-steps <number>', 'Maximum steps before timeout', String(DEFAULT_MAX_STEPS))
  .option('--model <name>', 'AI model to use')
  .option('--device <id>', 'Target device ID (for Android real devices or specific emulators)')
  .option('--ios-device <udid>', 'Physical iOS device UDID')
  .option('--team-id <id>', 'Apple Developer Team ID')
  .option('--app-file <path>', 'Path to .ipa file (optional for maestro-runner)')
  .option('--driver-port <port>', 'Driver host port (default: 8100 for wda, 6001 for maestro)')
  .option('--runner <type>', 'Runner backend: maestro, maestro-runner, wda, or xctest (default: maestro)')
  .option('--xctestrun-path <path>', 'Path to .xctestrun file (for xctest runner)')
  .option('--language <lang>', 'Device UI language (e.g., "Traditional Chinese (繁體中文)")')
  .option('--criteria <criteria...>', 'Success criteria (can specify multiple)')
  .option('--constraint <constraints...>', 'Constraints (can specify multiple)')
  .option('--live', 'Open live viewer in browser to watch execution')
  .option('--live-port <port>', 'Live viewer port (default: 7330)')
  .action(async (bundleIdArg?: string, taskArg?: string, options?: Record<string, unknown>) => {
    const runner = (options?.runner as RunnerType) ?? 'maestro';

    if (runner === 'maestro' && !isMaestroInstalled()) {
      console.log(pc.yellow('\n⚠️  Maestro is not installed.'));
      console.log(pc.dim('Run: phone-use install-maestro\n'));
      process.exit(1);
    }

    const taskFromOption = options?.task as string | undefined;
    let bundleId: string | undefined;
    let task: string | undefined;

    if (taskFromOption) {
      task = taskFromOption;
      bundleId = bundleIdArg;
    } else if (bundleIdArg && taskArg) {
      bundleId = bundleIdArg;
      task = taskArg;
    } else if (bundleIdArg && !taskArg) {
      task = bundleIdArg;
      bundleId = undefined;
    }

    if (!task) {
      console.error(pc.red('\n❌ Error: Task is required'));
      console.log(pc.dim('\nUsage:'));
      console.log(pc.dim('  phone-use run <bundleId> <task>'));
      console.log(pc.dim('  phone-use run --task "your task"'));
      console.log(pc.dim('  phone-use run "your task"'));
      process.exit(1);
    }

    const iosDeviceUdid = options?.iosDevice as string | undefined;
    const teamId = options?.teamId as string | undefined;
    const appFile = options?.appFile as string | undefined;
    const xctestrunPath = options?.xctestrunPath as string | undefined;

    // Runner-specific validation
    if (runner === 'xctest') {
      if (!options?.device && !iosDeviceUdid) {
        console.error(pc.red('\n❌ Error: --runner xctest requires --device <simulator-udid>'));
        console.log(pc.dim('\nUsage:'));
        console.log(pc.dim('  phone-use run <bundleId> <task> --device <sim-udid> --runner xctest'));
        console.log(pc.dim('  phone-use run <bundleId> <task> --device <sim-udid> --runner xctest --xctestrun-path /path/to/file.xctestrun'));
        process.exit(1);
      }
    } else if (runner === 'wda') {
      if (!iosDeviceUdid || !teamId) {
        console.error(pc.red('\n❌ Error: --runner wda requires --ios-device and --team-id'));
        console.log(pc.dim('\nUsage:'));
        console.log(pc.dim('  phone-use run <bundleId> <task> --ios-device <udid> --team-id <id> --runner wda'));
        process.exit(1);
      }
    } else if (iosDeviceUdid && runner === 'maestro' && (!teamId || !appFile)) {
      console.error(pc.red('\n❌ Error: --ios-device with maestro requires --team-id and --app-file'));
      console.log(pc.dim('\nUsage:'));
      console.log(pc.dim('  phone-use run <bundleId> <task> --ios-device <udid> --team-id <id> --app-file /path/to/app.ipa'));
      console.log(pc.dim('\nOr use wda runner (fastest, no --app-file needed):'));
      console.log(pc.dim('  phone-use run <bundleId> <task> --ios-device <udid> --team-id <id> --runner wda'));
      process.exit(1);
    }

    const { apiKey, provider, defaultModel } = getApiConfig(options?.model as string | undefined);

    const driverPort = runner === 'xctest'
      ? parseInt(String(options?.driverPort ?? 22087), 10)
      : runner === 'wda'
        ? parseInt(String(options?.driverPort ?? 8100), 10)
        : parseInt(String(options?.driverPort ?? 6001), 10);

    // For xctest runner, pass xctestrun path via iosDevice.appFile field
    const deviceId = options?.device as string | undefined;
    const config: TaskConfig = {
      bundleId,
      task,
      maxSteps: parseInt(String(options?.maxSteps ?? DEFAULT_MAX_STEPS), 10),
      model: String(options?.model ?? defaultModel),
      language: options?.language as string | undefined,
      deviceId: runner === 'xctest' ? (deviceId ?? iosDeviceUdid) : deviceId,
      successCriteria: options?.criteria as string[] | undefined,
      constraints: options?.constraint as string[] | undefined,
      runner,
      live: !!options?.live,
      livePort: options?.livePort ? parseInt(String(options.livePort), 10) : undefined,
      iosDevice: runner === 'xctest'
        ? { udid: deviceId ?? iosDeviceUdid ?? 'booted', appFile: xctestrunPath, driverPort }
        : iosDeviceUdid
          ? { udid: iosDeviceUdid, teamId, appFile, driverPort }
          : undefined,
    };

    const executor = new TaskExecutor(config, apiKey, provider);
    const result = await executor.execute();

    console.log('\n' + '═'.repeat(50));
    console.log(result.success ? pc.green('✅ SUCCESS') : pc.red('❌ FAILED'));
    console.log(pc.dim(`Steps: ${result.steps}`));
    console.log(pc.dim(`Reason: ${result.reason}`));
    console.log('═'.repeat(50) + '\n');

    process.exit(result.success ? 0 : 1);
  });

// ── audit command (Phase 1: iOS 26 simulator only) ─────────────────
program
  .command('audit')
  .description('Autonomous UX audit of a mobile app (Phase 1: iOS 26 simulator only)')
  .argument('<bundleId>', 'App bundle ID (e.g., com.apple.Preferences)')
  .option('--runner <type>', 'Runner backend (Phase 1: xctest only)', 'xctest')
  .option('--device <id>', 'Simulator device UDID (defaults to booted simulator)')
  .option('--ios-device <udid>', '[Phase 2] Physical iOS device UDID — not supported in Phase 1')
  .option('--team-id <id>', '[Phase 2] Apple Developer Team ID')
  .option('--xctestrun-path <path>', 'Path to .xctestrun file (optional, for xctest runner)')
  .option('--language <lang>', 'Device UI language (e.g., "zh-TW")')
  .option('--scope <area>', 'Focus the audit on a specific feature area (e.g., "checkout flow")')
  .option('-m, --max-steps <number>', 'Maximum steps before timeout', String(DEFAULT_AUDIT_MAX_STEPS))
  .option('--model <name>', 'AI model to use', 'gemini-2.5-flash')
  .option('--skip-launch', 'Attach to foreground app instead of launching (for pre-authenticated state)', false)
  .option('--output-dir <path>', 'Output directory for the report and evidence')
  .option('--stable-timeout <ms>', 'Max wait for screen stability after a navigation action', '2000')
  .option('--max-retries <n>', 'AI SDK maxRetries per call (rate limiter handles bursts; default 1)', '1')
  .option('--rpm-limit <n>', 'Gemini requests-per-minute cap (default 12 for free tier headroom)', '12')
  .option('--token-budget <n>', 'Warn if total input tokens exceed this budget', '200000')
  .option('--hard-timeout <ms>', 'Hard per-step timeout for a single AI call', '45000')
  .option('--live', 'Open a local live viewer in the browser while the audit runs', false)
  .option('--live-port <port>', 'Port for the --live viewer HTTP server', '7330')
  .option('--accessibility-pass', 'Run a second pass at accessibility-extra-large Dynamic Type size after the main audit', false)
  .action(async (bundleIdArg: string, options: Record<string, unknown>) => {
    try {
      const config = buildAuditConfig(bundleIdArg, options);
      await runAuditCommand(config, (executor) => {
        auditCancelCallback = () => executor.cancel();
      });
      process.exit(0);
    } catch (err) {
      formatAuditError(err);
      process.exit(1);
    } finally {
      auditCancelCallback = null;
    }
  });

/**
 * Build a validated AuditConfig from raw CLI options.
 * Enforces Phase 1 scope (iOS 26 simulator only) and defaults.
 */
function buildAuditConfig(bundleId: string, options: Record<string, unknown>): AuditConfig {
  if (!bundleId) {
    throw new Error('audit: bundleId is required. Usage: phone-use audit <bundleId>');
  }

  // Phase 1 scope gate: reject physical device attempts with a clear hint.
  if (options.iosDevice) {
    throw new AuditError(
      'E_DRIVER_NOT_READY',
      'Physical device audit is a Phase 2 feature. Phase 1 targets iOS 26 simulator only. Run the audit against a booted simulator instead (drop --ios-device).',
    );
  }
  const runner = (options.runner as RunnerType) ?? 'xctest';
  if (runner !== 'xctest') {
    throw new AuditError(
      'E_DRIVER_NOT_READY',
      `Runner "${runner}" is not supported in Phase 1. Audit mode targets iOS 26 simulator via --runner xctest only.`,
    );
  }

  const maxSteps = parseIntFlag(options.maxSteps, DEFAULT_AUDIT_MAX_STEPS, '--max-steps', { min: 1 });
  if (maxSteps > 40) {
    console.log(
      pc.yellow(
        `\n⚠️  --max-steps=${maxSteps} is higher than the 25-step default. ` +
          `Expect longer wall-clock and higher cost.`,
      ),
    );
  }

  const rpmLimit = parseIntFlag(options.rpmLimit, 12, '--rpm-limit', { min: 1 });
  const maxRetries = parseIntFlag(options.maxRetries, 1, '--max-retries', { min: 0 });
  const stableTimeout = parseIntFlag(options.stableTimeout, 2000, '--stable-timeout', { min: 100 });
  const tokenBudget = parseIntFlag(options.tokenBudget, 200_000, '--token-budget', { min: 1 });
  const hardTimeout = parseIntFlag(options.hardTimeout, 45_000, '--hard-timeout', { min: 1000 });
  const livePort = parseIntFlag(options.livePort, 7330, '--live-port', { min: 1, max: 65535 });

  // API key resolution reuses the run-command helper, which exits the process
  // with a formatted error on failure — that gives us the same UX as `run`.
  const { defaultModel } = getApiConfig(options.model as string | undefined);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputDir = options.outputDir
    ? path.resolve(process.cwd(), String(options.outputDir))
    : path.resolve(process.cwd(), `audit-output/${timestamp}-${bundleId}`);

  return {
    bundleId,
    runner,
    deviceId: options.device as string | undefined,
    language: options.language as string | undefined,
    scope: options.scope as string | undefined,
    model: String(options.model ?? defaultModel),
    maxSteps,
    outputDir,
    stableTimeout,
    maxRetries,
    rpmLimit,
    tokenBudget,
    hardTimeout,
    skipLaunch: Boolean(options.skipLaunch),
    live: Boolean(options.live),
    livePort,
    accessibilityPass: Boolean(options.accessibilityPass),
  };
}

/**
 * Parse a CLI integer flag, enforcing min/max bounds and rejecting NaN.
 * Throws a plain Error with the flag name so the user sees "audit:
 * --flag must be an integer ≥ N" rather than a silent NaN downstream.
 */
function parseIntFlag(
  raw: unknown,
  fallback: number,
  flagName: string,
  bounds: { min: number; max?: number },
): number {
  const source = raw ?? fallback;
  const parsed = parseInt(String(source), 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`audit: ${flagName} must be an integer (got "${String(source)}")`);
  }
  if (parsed < bounds.min) {
    throw new Error(`audit: ${flagName} must be ≥ ${bounds.min} (got ${parsed})`);
  }
  if (bounds.max !== undefined && parsed > bounds.max) {
    throw new Error(`audit: ${flagName} must be ≤ ${bounds.max} (got ${parsed})`);
  }
  return parsed;
}

/**
 * Top-level audit runner. Builds an AuditExecutor and runs its loop.
 * Errors inside the executor are returned via AuditRunResult.partialReason
 * or thrown as AuditError; formatAuditError() renders either shape.
 *
 * `onExecutorReady` is invoked once the executor has been constructed so
 * the audit action handler can wire it into the SIGINT cancel callback
 * (see `auditCancelCallback` in `setupSignalHandlers`).
 */
async function runAuditCommand(
  config: AuditConfig,
  onExecutorReady?: (executor: import('./audit-executor.js').AuditExecutor) => void,
): Promise<void> {
  const { apiKey, provider } = getApiConfig(config.model);
  const { AuditExecutor } = await import('./audit-executor.js');
  const executor = new AuditExecutor(config, apiKey, provider);
  onExecutorReady?.(executor);
  const result = await executor.executeAudit();

  console.log('\n' + '═'.repeat(50));
  console.log(result.success ? pc.green('✅ AUDIT COMPLETE') : pc.yellow('⚠️  AUDIT PARTIAL'));
  console.log(pc.dim(`Steps: ${result.stepsTotal}`));
  console.log(pc.dim(`Issues: ${result.issuesFound}`));
  if (result.partialReason) {
    console.log(pc.dim(`Reason: ${result.partialReason}`));
  }
  console.log(pc.dim(`Report: ${result.outputDir}`));
  console.log('═'.repeat(50) + '\n');

  if (!result.success) {
    // partialReason is now AuditPartialReason; map E_UNEXPECTED onto a real
    // AuditError code so the CLI formatter gets a clean signal.
    const code = result.partialReason && result.partialReason !== 'E_UNEXPECTED'
      ? result.partialReason
      : 'E_APP_CRASHED';
    throw new AuditError(
      code,
      'Audit did not complete successfully. See the partial report at the path above.',
    );
  }
}

/** Format an AuditError (or any error) for the CLI output. */
function formatAuditError(err: unknown): void {
  if (isAuditError(err)) {
    console.error(pc.red(`\n❌ Audit failed: ${err.code}`));
    console.error(pc.dim(`   ${err.hint}`));
    console.error(pc.dim(`   Troubleshooting: docs/audit-errors.md#${err.code.toLowerCase()}\n`));
    return;
  }
  if (err instanceof Error) {
    console.error(pc.red(`\n❌ ${redactSecrets(err.message)}`));
    console.error(pc.dim(`   Unknown error — stack above. If this looks like a bug, file an issue with the redacted message.\n`));
    if (err.stack) console.error(pc.dim(redactSecrets(err.stack)));
    return;
  }
  console.error(pc.red(`\n❌ Unexpected error: ${redactSecrets(String(err))}\n`));
}

/**
 * Redact likely-credential substrings from error messages before printing.
 * AI SDKs and HTTP libraries occasionally echo API keys, bearer tokens, or
 * query-string auth params in error text; this best-effort scrubber stops
 * the most common patterns from landing in the terminal.
 */
function redactSecrets(text: string): string {
  return text
    // Bearer tokens: "Authorization: Bearer abc..." or "Bearer abc..."
    .replace(/\b(Bearer\s+)[A-Za-z0-9._\-+/=]{8,}/gi, '$1<REDACTED>')
    // Generic "api_key=..." or "apiKey: ..." in URLs / JSON / headers
    .replace(/\b(api[_-]?key[=:]\s*["']?)[A-Za-z0-9._\-+/=]{8,}/gi, '$1<REDACTED>')
    // Google AI keys start with "AIza" and are 39 chars
    .replace(/\bAIza[A-Za-z0-9_\-]{35}\b/g, '<REDACTED>')
    // OpenAI keys start with "sk-" and have ≥ 20 chars after
    .replace(/\bsk-[A-Za-z0-9_\-]{20,}\b/g, '<REDACTED>')
    // "key=..." or "token=..." in query strings
    .replace(/\b(key|token|secret)=[A-Za-z0-9._\-+/=]{8,}/gi, '$1=<REDACTED>');
}

program
  .command('install-maestro')
  .description('Install Maestro CLI for mobile testing')
  .action(async () => {
    console.log(pc.cyan('\n📦 Maestro Installation\n'));

    const success = await ensureMaestroInstalled();
    process.exit(success ? 0 : 1);
  });

program
  .command('install-ios-device')
  .description('Install maestro-ios-device for physical iOS testing (macOS only)')
  .action(async () => {
    console.log(pc.cyan('\n📦 maestro-ios-device Installation\n'));

    if (process.platform !== 'darwin') {
      console.log(pc.red('❌ maestro-ios-device requires macOS with Xcode.\n'));
      process.exit(1);
    }

    const success = await ensureMaestroIosDeviceInstalled();
    process.exit(success ? 0 : 1);
  });

// Check command - verify environment is set up
program
  .command('check')
  .description('Check if the environment is properly configured')
  .action(async () => {
    console.log(pc.cyan('\n🔍 Environment Check\n'));

    let allGood = true;

    const maestroSpinner = createSpinner('Checking Maestro...').start();
    if (isMaestroInstalled()) {
      const { execSync } = await import('child_process');
      const version = execSync('maestro --version', { encoding: 'utf-8' }).trim();
      maestroSpinner.succeed(`Maestro installed: ${version}`);
    } else {
      maestroSpinner.fail('Maestro not installed');
      console.log(pc.dim('  Run: phone-use install-maestro'));
      allGood = false;
    }

    const apiSpinner = createSpinner('Checking API key...').start();
    const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    if (googleKey) {
      apiSpinner.succeed('Google AI API key configured (Gemini)');
    } else if (openaiKey) {
      apiSpinner.succeed('OpenAI API key configured');
    } else {
      apiSpinner.fail('No API key set');
      console.log(pc.dim('  Set GOOGLE_GENERATIVE_AI_API_KEY (recommended) or OPENAI_API_KEY'));
      allGood = false;
    }

    const nodeSpinner = createSpinner('Checking Node.js...').start();
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0] ?? '0', 10);
    if (majorVersion >= 18) {
      nodeSpinner.succeed(`Node.js ${nodeVersion}`);
    } else {
      nodeSpinner.fail(`Node.js ${nodeVersion} (requires >= 18)`);
      allGood = false;
    }

    if (process.platform === 'darwin') {
      const iosSpinner = createSpinner('Checking maestro-ios-device...').start();
      if (isMaestroIosDeviceInstalled()) {
        const { execSync } = await import('child_process');
        try {
          const version = execSync('maestro-ios-device --version', { encoding: 'utf-8' }).trim();
          iosSpinner.succeed(`maestro-ios-device installed: ${version}`);
        } catch {
          iosSpinner.succeed('maestro-ios-device installed');
        }
      } else {
        iosSpinner.warn('maestro-ios-device not installed (optional, for physical iOS)');
        console.log(pc.dim('  Run: phone-use install-ios-device'));
      }
    }

    console.log('');
    if (allGood) {
      console.log(pc.green('✅ All checks passed! Ready to use phone-use.\n'));
    } else {
      console.log(pc.yellow('⚠️  Some checks failed. Please fix the issues above.\n'));
      process.exit(1);
    }
  });

// MCP server command
program
  .command('mcp')
  .description('Start MCP server for AI agent integration (stdio transport)')
  .option('--runner <type>', 'Runner backend: maestro, wda, or xctest (default: maestro)')
  .option('--ios-device <udid>', 'Physical iOS device UDID')
  .option('--device <id>', 'Simulator device ID (for xctest runner)')
  .option('--team-id <id>', 'Apple Developer Team ID')
  .option('--driver-port <port>', 'Driver host port (default: 22087 for xctest, 8100 for wda, 6001 for maestro)')
  .option('--xctestrun-path <path>', 'Path to .xctestrun file (for xctest runner)')
  .action(async (options: Record<string, unknown>) => {
    const { startMcpServer } = await import('./mcp/server.js');
    const runner = (options.runner as RunnerType) ?? 'maestro';
    await startMcpServer({
      runner,
      iosDeviceUdid: (options.device as string | undefined) ?? (options.iosDevice as string | undefined),
      teamId: options.teamId as string | undefined,
      driverPort: options.driverPort ? parseInt(String(options.driverPort), 10) : undefined,
      xctestrunPath: options.xctestrunPath as string | undefined,
    });
  });

program
  .argument('[bundleId]', 'App bundle ID (optional - omit to use foreground app)')
  .argument('[task]', 'Task to execute')
  .option('-t, --task <task>', 'Task to execute (use when running without bundleId)')
  .option('-m, --max-steps <number>', 'Maximum steps', String(DEFAULT_MAX_STEPS))
  .option('--model <name>', 'AI model to use')
  .option('--device <id>', 'Target device ID')
  .option('--ios-device <udid>', 'Physical iOS device UDID')
  .option('--team-id <id>', 'Apple Developer Team ID')
  .option('--app-file <path>', 'Path to .ipa file')
  .option('--driver-port <port>', 'Driver host port (default: 8100 for wda, 6001 for maestro)')
  .option('--runner <type>', 'Runner backend: maestro, maestro-runner, wda, or xctest')
  .option('--xctestrun-path <path>', 'Path to .xctestrun file (for xctest runner)')
  .option('--language <lang>', 'Device UI language (e.g., "Traditional Chinese (繁體中文)")')
  .option('--criteria <criteria...>', 'Success criteria')
  .option('--constraint <constraints...>', 'Constraints')
  .option('--live', 'Open live viewer in browser to watch execution')
  .option('--live-port <port>', 'Live viewer port (default: 7330)')
  .action(async (bundleIdArg?: string, taskArg?: string, options?: Record<string, unknown>) => {
    const taskFromOption = options?.task as string | undefined;
    let bundleId: string | undefined;
    let task: string | undefined;

    if (taskFromOption) {
      task = taskFromOption;
      bundleId = bundleIdArg;
    } else if (bundleIdArg && taskArg) {
      bundleId = bundleIdArg;
      task = taskArg;
    } else if (bundleIdArg && !taskArg) {
      task = bundleIdArg;
      bundleId = undefined;
    }

    if (!task) {
      program.help();
      return;
    }

    const runner = (options?.runner as RunnerType) ?? 'maestro';

    if (runner === 'maestro' && !isMaestroInstalled()) {
      console.log(pc.yellow('\n⚠️  Maestro is not installed.'));
      console.log(pc.dim('Run: phone-use install-maestro\n'));
      process.exit(1);
    }

    const iosDeviceUdid = options?.iosDevice as string | undefined;
    const teamId = options?.teamId as string | undefined;
    const appFile = options?.appFile as string | undefined;
    const xctestrunPath2 = options?.xctestrunPath as string | undefined;

    if (runner === 'xctest') {
      if (!options?.device && !iosDeviceUdid) {
        console.error(pc.red('\n❌ Error: --runner xctest requires --device <simulator-udid>'));
        console.log(pc.dim('Usage: phone-use <bundleId> <task> --device <sim-udid> --runner xctest'));
        process.exit(1);
      }
    } else if (runner === 'wda' && (!iosDeviceUdid || !teamId)) {
      console.error(pc.red('\n❌ Error: --runner wda requires --ios-device and --team-id'));
      console.log(pc.dim('Usage: phone-use <bundleId> <task> --ios-device <udid> --team-id <id> --runner wda'));
      process.exit(1);
    } else if (iosDeviceUdid && runner === 'maestro' && (!teamId || !appFile)) {
      console.error(pc.red('\n❌ Error: --ios-device with maestro requires --team-id and --app-file'));
      console.log(pc.dim('Or use: --runner wda (fastest, no --app-file needed)'));
      process.exit(1);
    }

    const { apiKey, provider, defaultModel } = getApiConfig(options?.model as string | undefined);

    const driverPort = runner === 'xctest'
      ? parseInt(String(options?.driverPort ?? 22087), 10)
      : runner === 'wda'
        ? parseInt(String(options?.driverPort ?? 8100), 10)
        : parseInt(String(options?.driverPort ?? 6001), 10);

    const deviceId2 = options?.device as string | undefined;
    const config: TaskConfig = {
      bundleId,
      task,
      maxSteps: parseInt(String(options?.maxSteps ?? DEFAULT_MAX_STEPS), 10),
      model: String(options?.model ?? defaultModel),
      language: options?.language as string | undefined,
      deviceId: runner === 'xctest' ? (deviceId2 ?? iosDeviceUdid) : deviceId2,
      successCriteria: options?.criteria as string[] | undefined,
      constraints: options?.constraint as string[] | undefined,
      runner,
      live: !!options?.live,
      livePort: options?.livePort ? parseInt(String(options.livePort), 10) : undefined,
      iosDevice: runner === 'xctest'
        ? { udid: deviceId2 ?? iosDeviceUdid ?? 'booted', appFile: xctestrunPath2, driverPort }
        : iosDeviceUdid
          ? { udid: iosDeviceUdid, teamId, appFile, driverPort }
          : undefined,
    };

    const executor = new TaskExecutor(config, apiKey, provider);
    const result = await executor.execute();

    console.log('\n' + '═'.repeat(50));
    console.log(result.success ? pc.green('✅ SUCCESS') : pc.red('❌ FAILED'));
    console.log(pc.dim(`Steps: ${result.steps}`));
    console.log(pc.dim(`Reason: ${result.reason}`));
    console.log('═'.repeat(50) + '\n');

    process.exit(result.success ? 0 : 1);
  });

// Parse and execute (await + parseAsync needed for async action handlers in ESM)
await program.parseAsync();
