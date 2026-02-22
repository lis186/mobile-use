/**
 * XCTestClient - Direct HTTP client for Maestro's XCTest driver on iOS simulators.
 *
 * Bypasses the Maestro CLI (which hangs on macOS Tahoe 26.x) by communicating
 * directly with the XCTest driver's REST API on port 22087.
 *
 * The driver is started via `xcodebuild test-without-building` with the
 * `-only-testing` flag to run only the HTTP server test, skipping the
 * blocking `testLaunch()` test.
 */

import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { MobileDevice } from './core/device.js';

export interface XCTestConfig {
  simulatorId: string;
  xctestrunPath?: string;
  port?: number;
  bundleId?: string;
  saveEvalScreens?: boolean;
  evalScreensDir?: string;
}

export class XCTestClient implements MobileDevice {
  private simulatorId: string;
  private xctestrunPath: string | null;
  private port: number;
  private bundleId?: string;
  private saveEvalScreens: boolean;
  private evalScreensDir: string;

  private baseUrl: string;
  private widthPoints = 0;
  private heightPoints = 0;
  private xcodebuildProc: ChildProcess | null = null;
  private connected = false;
  private exitHandler: (() => void) | null = null;

  constructor(config: XCTestConfig) {
    this.simulatorId = config.simulatorId;
    this.xctestrunPath = config.xctestrunPath ?? null;
    this.port = config.port ?? 22087;
    this.bundleId = config.bundleId;
    this.saveEvalScreens = config.saveEvalScreens ?? false;
    this.evalScreensDir = config.evalScreensDir ?? './eval-screens';
    this.baseUrl = `http://localhost:${this.port}`;
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async connect(): Promise<void> {
    // Check if driver is already running externally
    if (await this.checkRunning()) {
      process.stderr.write(`[XCTest] Driver already running on port ${this.port}\n`);
      await this.fetchDeviceInfo();
      this.connected = true;
      return;
    }

    // Find or build the xctestrun
    const xctestrun = await this.resolveXctestrun();

    process.stderr.write(`[XCTest] Starting driver on simulator ${this.simulatorId}...\n`);

    this.xcodebuildProc = spawn(
      'xcodebuild',
      [
        'test-without-building',
        '-xctestrun', xctestrun,
        '-destination', `platform=iOS Simulator,id=${this.simulatorId}`,
        '-only-testing', 'maestro-driver-iosUITests/maestro_driver_iosUITests/testHttpServer',
      ],
      { stdio: 'ignore', detached: false }
    );

    this.xcodebuildProc.on('error', (err) => {
      process.stderr.write(`[XCTest] xcodebuild error: ${err.message}\n`);
    });

    this.xcodebuildProc.on('exit', (code) => {
      if (this.connected) {
        process.stderr.write(`[XCTest] xcodebuild exited with code ${code}\n`);
        this.connected = false;
      }
    });

    // Poll /status until driver is ready
    await this.pollReady(120_000);
    await this.fetchDeviceInfo();

    // Register cleanup
    this.exitHandler = () => this.syncCleanup();
    process.on('exit', this.exitHandler);

    this.connected = true;
    process.stderr.write(`[XCTest] Ready — screen=${this.widthPoints}x${this.heightPoints} points\n`);
  }

  async disconnect(): Promise<void> {
    process.stderr.write('[XCTest] Stopping...\n');
    if (this.exitHandler) {
      process.removeListener('exit', this.exitHandler);
      this.exitHandler = null;
    }
    this.syncCleanup();
    this.connected = false;
    process.stderr.write('[XCTest] Stopped\n');
  }

  isConnected(): boolean {
    return this.connected;
  }

  private syncCleanup(): void {
    if (this.xcodebuildProc && !this.xcodebuildProc.killed) {
      try {
        this.xcodebuildProc.kill('SIGTERM');
      } catch { /* ignore */ }
      this.xcodebuildProc = null;
    }
  }

  // ── xctestrun Resolution ───────────────────────────────────

  private async resolveXctestrun(): Promise<string> {
    // If explicitly provided, use it
    if (this.xctestrunPath && existsSync(this.xctestrunPath)) {
      return this.xctestrunPath;
    }

    // Search common locations
    const searchPaths = [
      '/tmp/maestro-driver-build/Build/Products',
      path.join(os.homedir(), '.maestro', 'maestro-ios-xctest-runner', 'build', 'Build', 'Products'),
    ];

    for (const dir of searchPaths) {
      if (!existsSync(dir)) continue;
      try {
        const files = execFileSync('find', [dir, '-name', '*.xctestrun', '-maxdepth', '1'], {
          encoding: 'utf-8',
          timeout: 5000,
        }).trim().split('\n').filter(Boolean);

        if (files.length > 0) {
          process.stderr.write(`[XCTest] Found xctestrun: ${files[0]}\n`);
          return files[0]!;
        }
      } catch { /* continue searching */ }
    }

    // Try to build from source
    return this.buildXctestrun();
  }

  private async buildXctestrun(): Promise<string> {
    const srcDir = path.join(os.homedir(), '.maestro', 'maestro-ios-xctest-runner');
    const projectPath = path.join(srcDir, 'maestro-driver-ios.xcodeproj');

    if (!existsSync(projectPath)) {
      throw new Error(
        '[XCTest] Cannot find maestro-driver-ios project. ' +
        'Install Maestro first (phone-use install-maestro) or provide --xctestrun-path'
      );
    }

    const buildDir = '/tmp/maestro-driver-build';
    process.stderr.write('[XCTest] Building XCTest driver (this may take a minute)...\n');

    try {
      execFileSync('xcodebuild', [
        'build-for-testing',
        '-project', projectPath,
        '-scheme', 'maestro-driver-ios',
        '-destination', 'generic/platform=iOS Simulator',
        '-derivedDataPath', buildDir,
      ], {
        stdio: 'pipe',
        timeout: 300_000,
        cwd: srcDir,
      });
    } catch (error: unknown) {
      const err = error as { stderr?: string; message?: string };
      throw new Error(`[XCTest] Build failed: ${(err.stderr || err.message || '').slice(0, 300)}`);
    }

    // Find the built xctestrun
    const productsDir = path.join(buildDir, 'Build', 'Products');
    try {
      const files = execFileSync('find', [productsDir, '-name', '*.xctestrun', '-maxdepth', '1'], {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim().split('\n').filter(Boolean);

      if (files.length > 0) {
        process.stderr.write(`[XCTest] Built xctestrun: ${files[0]}\n`);
        return files[0]!;
      }
    } catch { /* fall through */ }

    throw new Error('[XCTest] Build succeeded but xctestrun file not found');
  }

  // ── Polling & Device Info ──────────────────────────────────

  private async checkRunning(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/status`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        const data = await resp.json() as { status?: string };
        return data.status === 'ok';
      }
    } catch { /* not running */ }
    return false;
  }

  private async pollReady(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.checkRunning()) return;
      await sleep(1000);
    }
    throw new Error(`[XCTest] Timeout: driver not ready after ${timeoutMs / 1000}s`);
  }

  private async fetchDeviceInfo(): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/deviceInfo`);
    const data = await resp.json() as {
      widthPoints?: number;
      heightPoints?: number;
      widthPixels?: number;
      heightPixels?: number;
    };
    this.widthPoints = data.widthPoints ?? 402;
    this.heightPoints = data.heightPoints ?? 874;
  }

  // ── Coordinate Conversion ──────────────────────────────────

  /** Convert 0-100 percentage to device points */
  private pctToX(pct: number): number {
    return Math.round((this.widthPoints * pct) / 100 * 10) / 10;
  }

  private pctToY(pct: number): number {
    return Math.round((this.heightPoints * pct) / 100 * 10) / 10;
  }

  // ── HTTP Helpers ───────────────────────────────────────────

  private async post(urlPath: string, body?: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  private async get(urlPath: string): Promise<Response> {
    return fetch(`${this.baseUrl}${urlPath}`);
  }

  // ── MobileDevice: Observation ──────────────────────────────

  screenSize(): { width: number; height: number } {
    return { width: this.widthPoints, height: this.heightPoints };
  }

  async screenshot(): Promise<Buffer> {
    const resp = await this.get('/screenshot');
    if (!resp.ok) throw new Error(`[XCTest] Screenshot failed: ${resp.status}`);
    const arrayBuf = await resp.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  async screenshotBase64(stepNumber?: number): Promise<string> {
    const buffer = await this.screenshot();

    if (this.saveEvalScreens && stepNumber !== undefined) {
      mkdirSync(this.evalScreensDir, { recursive: true });
      const evalPath = path.join(
        this.evalScreensDir,
        `step-${String(stepNumber).padStart(3, '0')}-before.png`
      );
      writeFileSync(evalPath, buffer);
    }

    return buffer.toString('base64');
  }

  async accessibilityTree(): Promise<string> {
    const resp = await this.post('/viewHierarchy', {
      appIds: this.bundleId ? [this.bundleId] : [],
      excludeKeyboardElements: false,
    });
    if (!resp.ok) throw new Error(`[XCTest] View hierarchy failed: ${resp.status}`);
    const data = await resp.json();
    return JSON.stringify(data);
  }

  // ── MobileDevice: Actions ──────────────────────────────────

  async tap(x: number, y: number): Promise<void> {
    const resp = await this.post('/touch', {
      x: this.pctToX(x),
      y: this.pctToY(y),
      duration: 0.1,
    });
    if (!resp.ok) throw new Error(`[XCTest] Tap failed: ${await resp.text()}`);
  }

  async tapText(_text: string): Promise<void> {
    // XCTest driver doesn't have a find-by-text-and-tap endpoint.
    // Use the accessibility tree to find the element, then tap its center.
    const treeResp = await this.post('/viewHierarchy', {
      appIds: this.bundleId ? [this.bundleId] : [],
      excludeKeyboardElements: true,
    });
    if (!treeResp.ok) throw new Error(`[XCTest] tapText: hierarchy fetch failed`);

    const tree = await treeResp.json() as { axElement?: AXElement };
    const element = findElementByText(tree.axElement, _text);
    if (!element?.frame) {
      throw new Error(`[XCTest] Element with text "${_text}" not found`);
    }

    const cx = element.frame.X + element.frame.Width / 2;
    const cy = element.frame.Y + element.frame.Height / 2;
    const resp = await this.post('/touch', { x: cx, y: cy, duration: 0.1 });
    if (!resp.ok) throw new Error(`[XCTest] tapText: tap failed`);
  }

  async doubleTap(x: number, y: number): Promise<void> {
    // XCTest driver has no double-tap endpoint; simulate with two quick taps
    await this.tap(x, y);
    await sleep(50);
    await this.tap(x, y);
  }

  async longPress(x: number, y: number): Promise<void> {
    const resp = await this.post('/touch', {
      x: this.pctToX(x),
      y: this.pctToY(y),
      duration: 1.0,
    });
    if (!resp.ok) throw new Error(`[XCTest] Long press failed: ${await resp.text()}`);
  }

  async inputText(text: string): Promise<void> {
    const appIds = this.bundleId ? [this.bundleId] : [];
    const resp = await this.post('/inputText', { text, appIds });
    if (!resp.ok) throw new Error(`[XCTest] Input text failed: ${await resp.text()}`);
  }

  async eraseText(chars: number = 50): Promise<void> {
    const appIds = this.bundleId ? [this.bundleId] : [];
    const resp = await this.post('/eraseText', { charactersToErase: chars, appIds });
    if (!resp.ok) throw new Error(`[XCTest] Erase text failed: ${await resp.text()}`);
  }

  async scroll(): Promise<void> {
    await this.swipe(50, 70, 50, 30);
  }

  async swipe(startX: number, startY: number, endX: number, endY: number): Promise<void> {
    const appIds = this.bundleId ? [this.bundleId] : [];
    const resp = await this.post('/swipeV2', {
      startX: this.pctToX(startX),
      startY: this.pctToY(startY),
      endX: this.pctToX(endX),
      endY: this.pctToY(endY),
      duration: 0.3,
      appIds,
    });
    if (!resp.ok) throw new Error(`[XCTest] Swipe failed: ${await resp.text()}`);
  }

  async back(): Promise<void> {
    // iOS back gesture: swipe from left edge to right
    await this.swipe(1, 50, 80, 50);
  }

  async hideKeyboard(): Promise<void> {
    // Try pressing "return" to dismiss; fall back to tapping above keyboard
    try {
      await this.post('/pressKey', { key: 'return' });
    } catch {
      await this.tap(50, 10);
    }
  }

  async openLink(url: string): Promise<void> {
    // Use simctl to open the URL on the simulator
    execFileSync('xcrun', ['simctl', 'openurl', this.simulatorId, url], {
      stdio: 'ignore',
      timeout: 10_000,
    });
  }

  async pressKey(key: string): Promise<void> {
    const keyMap: Record<string, string> = {
      enter: 'return',
      return: 'return',
      delete: 'delete',
      backspace: 'delete',
      tab: 'tab',
      escape: 'escape',
      space: 'space',
    };

    const mappedKey = keyMap[key.toLowerCase()];
    if (mappedKey) {
      const resp = await this.post('/pressKey', { key: mappedKey });
      if (!resp.ok) throw new Error(`[XCTest] Press key failed: ${await resp.text()}`);
    } else if (key.toLowerCase() === 'home') {
      const resp = await this.post('/pressButton', { button: 'home' });
      if (!resp.ok) throw new Error(`[XCTest] Press button failed: ${await resp.text()}`);
    } else {
      throw new Error(`[XCTest] Unsupported key: ${key}`);
    }
  }

  // ── App Management ─────────────────────────────────────────

  async launchApp(bundleId: string): Promise<void> {
    const resp = await this.post('/launchApp', { bundleId });
    if (!resp.ok) throw new Error(`[XCTest] Launch app failed: ${await resp.text()}`);
  }

  async stopApp(bundleId: string): Promise<void> {
    const resp = await this.post('/terminateApp', { appId: bundleId });
    if (!resp.ok) throw new Error(`[XCTest] Terminate app failed: ${await resp.text()}`);
  }

  // ── Extra Methods (used by executor) ───────────────────────

  hasBundleId(): boolean {
    return !!this.bundleId;
  }

  async launch(): Promise<void> {
    if (this.bundleId) await this.launchApp(this.bundleId);
  }

  async waitForAnimation(timeout: number = 3000): Promise<void> {
    await sleep(timeout);
  }

  async iosBackGesture(): Promise<void> {
    await this.swipe(1, 50, 80, 50);
  }

  async longPressText(text: string): Promise<void> {
    const treeResp = await this.post('/viewHierarchy', {
      appIds: this.bundleId ? [this.bundleId] : [],
      excludeKeyboardElements: true,
    });
    if (!treeResp.ok) throw new Error(`[XCTest] longPressText: hierarchy fetch failed`);

    const tree = await treeResp.json() as { axElement?: AXElement };
    const element = findElementByText(tree.axElement, text);
    if (!element?.frame) {
      throw new Error(`[XCTest] Element with text "${text}" not found`);
    }

    const cx = element.frame.X + element.frame.Width / 2;
    const cy = element.frame.Y + element.frame.Height / 2;
    const resp = await this.post('/touch', { x: cx, y: cy, duration: 1.0 });
    if (!resp.ok) throw new Error(`[XCTest] longPressText: tap failed`);
  }

  /** @deprecated Use accessibilityTree() instead */
  async getAccessibilityTree(): Promise<string> {
    return this.accessibilityTree();
  }
}

// ── Accessibility Tree Element Types ─────────────────────────

interface AXElement {
  label?: string;
  title?: string;
  value?: string;
  identifier?: string;
  frame?: { X: number; Y: number; Width: number; Height: number };
  children?: AXElement[];
}

function findElementByText(element: AXElement | undefined, text: string): AXElement | null {
  if (!element) return null;

  const lowerText = text.toLowerCase();
  if (
    element.label?.toLowerCase().includes(lowerText) ||
    element.title?.toLowerCase().includes(lowerText) ||
    element.value?.toLowerCase().includes(lowerText)
  ) {
    return element;
  }

  if (element.children) {
    for (const child of element.children) {
      const found = findElementByText(child, text);
      if (found) return found;
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
