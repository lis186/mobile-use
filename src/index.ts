/**
 * Mobile Use - AI-powered mobile task automation
 * Execute tasks on mobile apps using natural language
 */

import 'dotenv/config';
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
import type { TaskConfig, RunnerType } from './types.js';
import { inferProvider, getApiConfig as getApiConfigBase } from './cli/api-config.js';

const DEFAULT_MAX_STEPS = 100;

// Handle graceful shutdown
let isShuttingDown = false;

function setupSignalHandlers(): void {
  const shutdown = (signal: string) => {
    if (isShuttingDown) {
      process.stderr.write('\n\nForce quitting...\n');
      process.exit(1);
    }
    isShuttingDown = true;
    process.stderr.write(`\n\n${signal} received. Shutting down gracefully...\n`);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
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

program.name('mobile-use').description('AI-powered mobile task automation using Maestro and OpenAI').version('1.0.0').enablePositionalOptions();

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
  .option('--runner <type>', 'Runner backend: maestro, maestro-runner, or wda (default: maestro)')
  .option('--language <lang>', 'Device UI language (e.g., "Traditional Chinese (繁體中文)")')
  .option('--criteria <criteria...>', 'Success criteria (can specify multiple)')
  .option('--constraint <constraints...>', 'Constraints (can specify multiple)')
  .action(async (bundleIdArg?: string, taskArg?: string, options?: Record<string, unknown>) => {
    const runner = (options?.runner as RunnerType) ?? 'maestro';

    if (runner === 'maestro' && !isMaestroInstalled()) {
      console.log(pc.yellow('\n⚠️  Maestro is not installed.'));
      console.log(pc.dim('Run: mobile-use install-maestro\n'));
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
      console.log(pc.dim('  mobile-use run <bundleId> <task>'));
      console.log(pc.dim('  mobile-use run --task "your task"'));
      console.log(pc.dim('  mobile-use run "your task"'));
      process.exit(1);
    }

    const iosDeviceUdid = options?.iosDevice as string | undefined;
    const teamId = options?.teamId as string | undefined;
    const appFile = options?.appFile as string | undefined;

    // WDA runner: requires --ios-device and --team-id, no --app-file needed
    if (runner === 'wda') {
      if (!iosDeviceUdid || !teamId) {
        console.error(pc.red('\n❌ Error: --runner wda requires --ios-device and --team-id'));
        console.log(pc.dim('\nUsage:'));
        console.log(pc.dim('  mobile-use run <bundleId> <task> --ios-device <udid> --team-id <id> --runner wda'));
        process.exit(1);
      }
    } else if (iosDeviceUdid && runner === 'maestro' && (!teamId || !appFile)) {
      console.error(pc.red('\n❌ Error: --ios-device with maestro requires --team-id and --app-file'));
      console.log(pc.dim('\nUsage:'));
      console.log(pc.dim('  mobile-use run <bundleId> <task> --ios-device <udid> --team-id <id> --app-file /path/to/app.ipa'));
      console.log(pc.dim('\nOr use wda runner (fastest, no --app-file needed):'));
      console.log(pc.dim('  mobile-use run <bundleId> <task> --ios-device <udid> --team-id <id> --runner wda'));
      process.exit(1);
    }

    const { apiKey, provider, defaultModel } = getApiConfig(options?.model as string | undefined);

    const driverPort = runner === 'wda'
      ? parseInt(String(options?.driverPort ?? 8100), 10)
      : parseInt(String(options?.driverPort ?? 6001), 10);

    const config: TaskConfig = {
      bundleId,
      task,
      maxSteps: parseInt(String(options?.maxSteps ?? DEFAULT_MAX_STEPS), 10),
      model: String(options?.model ?? defaultModel),
      language: options?.language as string | undefined,
      deviceId: options?.device as string | undefined,
      successCriteria: options?.criteria as string[] | undefined,
      constraints: options?.constraint as string[] | undefined,
      runner,
      iosDevice: iosDeviceUdid
        ? {
            udid: iosDeviceUdid,
            teamId,
            appFile,
            driverPort,
          }
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
      console.log(pc.dim('  Run: mobile-use install-maestro'));
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
        console.log(pc.dim('  Run: mobile-use install-ios-device'));
      }
    }

    console.log('');
    if (allGood) {
      console.log(pc.green('✅ All checks passed! Ready to use mobile-use.\n'));
    } else {
      console.log(pc.yellow('⚠️  Some checks failed. Please fix the issues above.\n'));
      process.exit(1);
    }
  });

// MCP server command
program
  .command('mcp')
  .description('Start MCP server for AI agent integration (stdio transport)')
  .option('--runner <type>', 'Runner backend: maestro or wda (default: maestro)')
  .option('--ios-device <udid>', 'Physical iOS device UDID')
  .option('--team-id <id>', 'Apple Developer Team ID')
  .option('--driver-port <port>', 'Driver host port (default: 8100 for wda, 6001 for maestro)')
  .action(async (options: Record<string, unknown>) => {
    const { startMcpServer } = await import('./mcp/server.js');
    const runner = (options.runner as RunnerType) ?? 'maestro';
    await startMcpServer({
      runner,
      iosDeviceUdid: options.iosDevice as string | undefined,
      teamId: options.teamId as string | undefined,
      driverPort: options.driverPort ? parseInt(String(options.driverPort), 10) : undefined,
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
  .option('--runner <type>', 'Runner backend: maestro, maestro-runner, or wda')
  .option('--language <lang>', 'Device UI language (e.g., "Traditional Chinese (繁體中文)")')
  .option('--criteria <criteria...>', 'Success criteria')
  .option('--constraint <constraints...>', 'Constraints')
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
      console.log(pc.dim('Run: mobile-use install-maestro\n'));
      process.exit(1);
    }

    const iosDeviceUdid = options?.iosDevice as string | undefined;
    const teamId = options?.teamId as string | undefined;
    const appFile = options?.appFile as string | undefined;

    if (runner === 'wda' && (!iosDeviceUdid || !teamId)) {
      console.error(pc.red('\n❌ Error: --runner wda requires --ios-device and --team-id'));
      console.log(pc.dim('Usage: mobile-use <bundleId> <task> --ios-device <udid> --team-id <id> --runner wda'));
      process.exit(1);
    } else if (iosDeviceUdid && runner === 'maestro' && (!teamId || !appFile)) {
      console.error(pc.red('\n❌ Error: --ios-device with maestro requires --team-id and --app-file'));
      console.log(pc.dim('Or use: --runner wda (fastest, no --app-file needed)'));
      process.exit(1);
    }

    const { apiKey, provider, defaultModel } = getApiConfig(options?.model as string | undefined);

    const driverPort = runner === 'wda'
      ? parseInt(String(options?.driverPort ?? 8100), 10)
      : parseInt(String(options?.driverPort ?? 6001), 10);

    const config: TaskConfig = {
      bundleId,
      task,
      maxSteps: parseInt(String(options?.maxSteps ?? DEFAULT_MAX_STEPS), 10),
      model: String(options?.model ?? defaultModel),
      language: options?.language as string | undefined,
      deviceId: options?.device as string | undefined,
      successCriteria: options?.criteria as string[] | undefined,
      constraints: options?.constraint as string[] | undefined,
      runner,
      iosDevice: iosDeviceUdid
        ? {
            udid: iosDeviceUdid,
            teamId,
            appFile,
            driverPort,
          }
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

// Parse and execute
program.parse();
