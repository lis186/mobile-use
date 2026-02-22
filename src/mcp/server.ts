/**
 * MCP Server — exposes mobile automation as MCP tools over stdio transport.
 * Lazy device connection, persistent session, graceful shutdown.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import sharp from 'sharp';
import type { MobileDevice } from '../core/device.js';
import { parseAccessibilityTree } from '../core/tree-parser.js';
import { WDAClient } from '../wda.js';
import { MaestroClient } from '../maestro.js';
import { XCTestClient } from '../xctest.js';
import type { RunnerType } from '../types.js';

export interface McpServerConfig {
  runner: RunnerType;
  iosDeviceUdid?: string;
  teamId?: string;
  driverPort?: number;
  xctestrunPath?: string;
}

// ── Device Session Manager ────────────────────────────────────

class DeviceSession {
  private device: MobileDevice | null = null;
  private config: McpServerConfig;

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  async getDevice(): Promise<MobileDevice> {
    if (this.device?.isConnected()) {
      return this.device;
    }

    // Create and connect device
    this.device = this.createDevice();
    try {
      await this.device.connect();
    } catch (err) {
      this.device = null;
      throw err;
    }
    return this.device;
  }

  /** Retry once on stale session */
  async withDevice<T>(fn: (device: MobileDevice) => Promise<T>): Promise<T> {
    const device = await this.getDevice();
    try {
      return await fn(device);
    } catch (err) {
      // Retry once — session may have expired
      if (this.device) {
        try { await this.device.disconnect(); } catch { /* ignore */ }
        this.device = null;
      }
      const fresh = await this.getDevice();
      return fn(fresh);
    }
  }

  async cleanup(): Promise<void> {
    if (this.device) {
      try { await this.device.disconnect(); } catch { /* ignore */ }
      this.device = null;
    }
  }

  private createDevice(): MobileDevice {
    const { runner, iosDeviceUdid, teamId, driverPort, xctestrunPath } = this.config;

    if (runner === 'xctest') {
      return new XCTestClient({
        simulatorId: iosDeviceUdid ?? 'booted',
        xctestrunPath,
        port: driverPort ?? 22087,
      });
    }

    if (runner === 'wda') {
      return new WDAClient({
        udid: iosDeviceUdid ?? '',
        teamId: teamId ?? '',
        port: driverPort ?? 8100,
      });
    }

    return new MaestroClient({
      runner,
      iosDevice: iosDeviceUdid
        ? { udid: iosDeviceUdid, teamId, driverPort }
        : undefined,
    });
  }
}

// ── Tool Helpers ──────────────────────────────────────────────

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true as const };
}

async function compressScreenshot(raw: Buffer): Promise<Buffer> {
  const metadata = await sharp(raw).metadata();
  const targetWidth = Math.round((metadata.width ?? 800) / 2);
  return sharp(raw).resize(targetWidth).jpeg({ quality: 80 }).toBuffer();
}

// ── Server Bootstrap ──────────────────────────────────────────

export async function startMcpServer(config: McpServerConfig): Promise<void> {
  const session = new DeviceSession(config);

  const server = new McpServer({
    name: 'phone-use',
    version: '1.0.0',
  });

  // ── Observation Tools ─────────────────────────────────────

  server.registerTool('screenshot', {
    description: 'Capture device screen as a JPEG image',
  }, async () => {
    try {
      return await session.withDevice(async (device) => {
        const raw = await device.screenshot();
        const jpeg = await compressScreenshot(raw);
        return {
          content: [{
            type: 'image' as const,
            data: jpeg.toString('base64'),
            mimeType: 'image/jpeg',
          }],
        };
      });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  server.registerTool('accessibility_tree', {
    description: 'Get parsed accessibility tree of current screen',
    inputSchema: { raw: z.boolean().optional().describe('Return raw XML/JSON instead of parsed text') },
  }, async ({ raw }) => {
    try {
      return await session.withDevice(async (device) => {
        const rawTree = await device.accessibilityTree();
        if (raw) {
          return textResult(rawTree);
        }
        const parsed = parseAccessibilityTree(rawTree);
        const elementCount = parsed ? parsed.split('\n').length : 0;
        if (elementCount < 2) {
          return textResult('(tree too sparse — fewer than 2 labeled elements)');
        }
        return textResult(parsed);
      });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  // ── Action Tools ──────────────────────────────────────────

  server.registerTool('tap', {
    description: 'Tap at coordinates (percentage 0-100)',
    inputSchema: { x: z.number().min(0).max(100).describe('X coordinate (0-100%)'), y: z.number().min(0).max(100).describe('Y coordinate (0-100%)') },
  }, async ({ x, y }) => {
    try {
      await session.withDevice(async (device) => { await device.tap(x, y); });
      return textResult(`Tapped at (${x}, ${y})`);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  server.registerTool('tap_text', {
    description: 'Tap on a visible text element by exact label match',
    inputSchema: { text: z.string().describe('Exact visible text to tap on') },
  }, async ({ text }) => {
    try {
      await session.withDevice(async (device) => { await device.tapText(text); });
      return textResult(`Tapped text "${text}"`);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  server.registerTool('input_text', {
    description: 'Type text into the currently focused field',
    inputSchema: { text: z.string().describe('Text to type') },
  }, async ({ text }) => {
    try {
      await session.withDevice(async (device) => { await device.inputText(text); });
      return textResult(`Typed "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  server.registerTool('erase_text', {
    description: 'Delete characters from the currently focused field',
    inputSchema: { chars: z.number().optional().describe('Number of characters to erase (default: 50)') },
  }, async ({ chars }) => {
    try {
      await session.withDevice(async (device) => { await device.eraseText(chars ?? 50); });
      return textResult(`Erased ${chars ?? 50} characters`);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  server.registerTool('scroll', {
    description: 'Scroll down on the current view',
  }, async () => {
    try {
      await session.withDevice(async (device) => { await device.scroll(); });
      return textResult('Scrolled down');
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  server.registerTool('swipe', {
    description: 'Swipe gesture from start to end coordinates (percentage 0-100)',
    inputSchema: {
      startX: z.number().min(0).max(100).describe('Start X (0-100%)'),
      startY: z.number().min(0).max(100).describe('Start Y (0-100%)'),
      endX: z.number().min(0).max(100).describe('End X (0-100%)'),
      endY: z.number().min(0).max(100).describe('End Y (0-100%)'),
    },
  }, async ({ startX, startY, endX, endY }) => {
    try {
      await session.withDevice(async (device) => { await device.swipe(startX, startY, endX, endY); });
      return textResult(`Swiped (${startX},${startY}) → (${endX},${endY})`);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  server.registerTool('back', {
    description: 'Navigate back (swipe-from-edge on iOS)',
  }, async () => {
    try {
      await session.withDevice(async (device) => { await device.back(); });
      return textResult('Navigated back');
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  server.registerTool('hide_keyboard', {
    description: 'Dismiss the on-screen keyboard',
  }, async () => {
    try {
      await session.withDevice(async (device) => { await device.hideKeyboard(); });
      return textResult('Keyboard dismissed');
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  server.registerTool('open_link', {
    description: 'Open a URL or deep link on the device',
    inputSchema: { url: z.string().describe('URL or deep link to open') },
  }, async ({ url }) => {
    try {
      await session.withDevice(async (device) => { await device.openLink(url); });
      return textResult(`Opened: ${url}`);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  server.registerTool('press_key', {
    description: 'Send a key event (e.g., home, enter, delete)',
    inputSchema: { key: z.string().describe('Key name: home, enter, delete, tab, escape, space') },
  }, async ({ key }) => {
    try {
      await session.withDevice(async (device) => { await device.pressKey(key); });
      return textResult(`Pressed key: ${key}`);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  // ── App Management Tools ──────────────────────────────────

  server.registerTool('launch_app', {
    description: 'Launch an app by bundle identifier',
    inputSchema: { bundleId: z.string().describe('App bundle ID (e.g., com.apple.Preferences)') },
  }, async ({ bundleId }) => {
    try {
      await session.withDevice(async (device) => { await device.launchApp(bundleId); });
      return textResult(`Launched: ${bundleId}`);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  server.registerTool('stop_app', {
    description: 'Stop/terminate a running app',
    inputSchema: { bundleId: z.string().describe('App bundle ID to stop') },
  }, async ({ bundleId }) => {
    try {
      await session.withDevice(async (device) => { await device.stopApp(bundleId); });
      return textResult(`Stopped: ${bundleId}`);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  server.registerTool('device_info', {
    description: 'Get information about the connected device',
  }, async () => {
    try {
      return await session.withDevice(async (device) => {
        const size = device.screenSize();
        return textResult(JSON.stringify({
          screenWidth: size.width,
          screenHeight: size.height,
          runner: config.runner,
          connected: device.isConnected(),
        }));
      });
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  server.registerTool('run_task', {
    description: 'Delegate a complete task to the autonomous AI agent',
    inputSchema: {
      task: z.string().describe('Task to execute in natural language'),
      bundleId: z.string().optional().describe('App bundle ID to launch first'),
      maxSteps: z.number().optional().describe('Maximum steps (default: 30)'),
      model: z.string().optional().describe('AI model to use (default: auto-detect)'),
    },
  }, async ({ task, bundleId, maxSteps, model }) => {
    try {
      // Dynamically import to avoid pulling AI deps into basic MCP tools
      const { TaskExecutor } = await import('../executor.js');
      const { getApiConfig } = await import('../cli/api-config.js');

      let apiConfig;
      try {
        apiConfig = getApiConfig(model);
      } catch {
        return errorResult('No AI API key configured. Set GOOGLE_GENERATIVE_AI_API_KEY or OPENAI_API_KEY.');
      }

      const executorConfig = {
        task,
        bundleId,
        maxSteps: maxSteps ?? 30,
        model: model ?? apiConfig.defaultModel,
        runner: config.runner as RunnerType,
        iosDevice: config.iosDeviceUdid
          ? { udid: config.iosDeviceUdid, teamId: config.teamId, driverPort: config.driverPort }
          : undefined,
      };

      const executor = new TaskExecutor(executorConfig, apiConfig.apiKey, apiConfig.provider);
      const result = await executor.execute();

      return textResult(JSON.stringify({
        success: result.success,
        steps: result.steps,
        reason: result.reason,
      }));
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  // ── Graceful Shutdown ─────────────────────────────────────

  process.on('SIGTERM', async () => {
    await session.cleanup();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await session.cleanup();
    process.exit(0);
  });

  // ── Start Server ──────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is reserved for MCP JSON-RPC)
  process.stderr.write(`[phone-use] MCP server running (runner=${config.runner})\n`);
}
