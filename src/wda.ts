/**
 * WDAClient - Direct HTTP client for WebDriverAgent on real iOS devices.
 *
 * Instead of going through Maestro CLI (which restarts WDA per action),
 * this keeps WDA running as a persistent HTTP server and sends
 * W3C WebDriver commands directly — ~24-143x faster per action.
 */

import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import type { MobileDevice } from './core/device.js';

export interface WDAConfig {
  udid: string;
  teamId: string;
  bundleId?: string;
  wdaProjectPath?: string;
  port?: number;
  saveEvalScreens?: boolean;
  evalScreensDir?: string;
}

export class WDAClient implements MobileDevice {
  private udid: string;
  private teamId: string;
  private bundleId?: string;
  private wdaProjectPath: string;
  private port: number;
  private saveEvalScreens: boolean;
  private evalScreensDir: string;

  private baseUrl: string;
  private sessionId: string | null = null;
  private screenWidth = 0;
  private screenHeight = 0;
  private xcodebuildProc: ChildProcess | null = null;
  private iproxyProc: ChildProcess | null = null;
  private exitHandler: (() => void) | null = null;
  private managedProcesses = false;

  constructor(config: WDAConfig) {
    this.udid = config.udid;
    this.teamId = config.teamId;
    this.bundleId = config.bundleId;
    this.wdaProjectPath = config.wdaProjectPath ?? '/tmp/WebDriverAgent';
    this.port = config.port ?? 8100;
    this.saveEvalScreens = config.saveEvalScreens ?? false;
    this.evalScreensDir = config.evalScreensDir ?? './eval-screens';
    this.baseUrl = `http://localhost:${this.port}`;
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    // Check if WDA is already running (externally managed)
    if (await this.checkRunning()) {
      process.stderr.write(`[WDA] Already running — connecting to existing instance on port ${this.port}\n`);
      await this.createSession();
      await this.fetchScreenSize();
      process.stderr.write(`[WDA] Connected — session=${this.sessionId}, screen=${this.screenWidth}x${this.screenHeight}\n`);
      return;
    }

    // Full lifecycle: start processes ourselves
    this.managedProcesses = true;
    this.killLeftovers();

    process.stderr.write(`[WDA] Starting xcodebuild + iproxy on port ${this.port}...\n`);

    // Start iproxy: forward localhost:port → device:8100
    this.iproxyProc = spawn('iproxy', [String(this.port), '8100', '-u', this.udid], {
      stdio: 'ignore',
      detached: false,
    });
    this.iproxyProc.unref();

    // Start xcodebuild test-without-building
    this.xcodebuildProc = spawn(
      'xcodebuild',
      [
        'test-without-building',
        '-project',
        path.join(this.wdaProjectPath, 'WebDriverAgent.xcodeproj'),
        '-scheme',
        'WebDriverAgentRunner',
        '-destination',
        `id=${this.udid}`,
        `DEVELOPMENT_TEAM=${this.teamId}`,
        'USE_PORT=8100',
      ],
      { stdio: 'ignore', detached: false }
    );
    this.xcodebuildProc.unref();

    // Poll /status until WDA is ready
    await this.pollReady(60_000);

    // Create session
    await this.createSession();

    // Get screen size for coordinate conversion
    await this.fetchScreenSize();

    // Register synchronous cleanup for process.exit() / Ctrl-C
    this.exitHandler = () => this.syncCleanup();
    process.on('exit', this.exitHandler);

    process.stderr.write(`[WDA] Ready — session=${this.sessionId}, screen=${this.screenWidth}x${this.screenHeight}\n`);
  }

  async stop(): Promise<void> {
    process.stderr.write('[WDA] Stopping...\n');
    if (this.sessionId) {
      try {
        await this.wdaFetch(`/session/${this.sessionId}`, { method: 'DELETE' });
      } catch {
        // Best-effort session cleanup
      }
      this.sessionId = null;
    }
    if (this.managedProcesses) {
      if (this.exitHandler) {
        process.removeListener('exit', this.exitHandler);
        this.exitHandler = null;
      }
      this.syncCleanup();
    }
    process.stderr.write('[WDA] Stopped\n');
  }

  /** Synchronous cleanup — safe to call from process 'exit' handler */
  private syncCleanup(): void {
    this.killProc(this.xcodebuildProc);
    this.killProc(this.iproxyProc);
    this.xcodebuildProc = null;
    this.iproxyProc = null;
    this.killLeftovers();
  }

  private killProc(proc: ChildProcess | null): void {
    if (!proc || proc.killed) return;
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }

  private killLeftovers(): void {
    // Use pkill with execFileSync (no shell injection risk — all args are hardcoded)
    try {
      execFileSync('pkill', ['-f', 'xcodebuild.*WebDriverAgent'], { stdio: 'ignore' });
    } catch {
      // pkill exits non-zero when no processes matched — that's fine
    }
    try {
      execFileSync('pkill', ['-f', `iproxy.*${this.port}`], { stdio: 'ignore' });
    } catch {
      // same
    }
  }

  private async checkRunning(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/status`);
      if (resp.ok) {
        const data = (await resp.json()) as { value?: { ready?: boolean; ios?: { ip?: string } } };
        if (data.value?.ready === true) {
          // If WDA reports a device IP, switch to it directly.
          // iproxy 2.x has a POST body forwarding bug that returns schema
          // placeholders instead of real data — bypassing it fixes CJK and
          // all other POST-based commands.
          const deviceIp = data.value.ios?.ip;
          if (deviceIp && deviceIp !== '127.0.0.1') {
            const directUrl = `http://${deviceIp}:${this.port}`;
            process.stderr.write(
              `[WDA] Switching to direct device IP ${directUrl} (bypasses iproxy POST bug)\n`
            );
            this.baseUrl = directUrl;
          }
          return true;
        }
      }
    } catch {
      // Not running
    }
    return false;
  }

  private async pollReady(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await fetch(`${this.baseUrl}/status`);
        if (resp.ok) {
          const data = (await resp.json()) as { value?: { ready?: boolean } };
          if (data.value?.ready) return;
        }
      } catch {
        // Not ready yet
      }
      await sleep(1000);
    }
    throw new Error(`[WDA] Timeout: WDA not ready after ${timeoutMs / 1000}s`);
  }

  private async createSession(): Promise<void> {
    const resp = await this.wdaFetch('/session', {
      method: 'POST',
      body: JSON.stringify({ capabilities: {} }),
    });
    const data = (await resp.json()) as { value?: { sessionId?: string }; sessionId?: string };
    this.sessionId = data.value?.sessionId ?? data.sessionId ?? null;
    if (!this.sessionId) {
      throw new Error('[WDA] Failed to create session');
    }
  }

  private async fetchScreenSize(): Promise<void> {
    const resp = await this.sessionFetch('/window/size');
    const data = (await resp.json()) as { value?: { width?: number; height?: number } };
    this.screenWidth = data.value?.width ?? 390;
    this.screenHeight = data.value?.height ?? 844;
  }

  // ── HTTP Helpers ───────────────────────────────────────────

  private async wdaFetch(urlPath: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.baseUrl}${urlPath}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  }

  private async sessionFetch(subpath: string, init?: RequestInit): Promise<Response> {
    if (!this.sessionId) throw new Error('[WDA] No active session');
    return this.wdaFetch(`/session/${this.sessionId}${subpath}`, init);
  }

  // ── Coordinate Conversion ─────────────────────────────────

  private pctToPixelX(pct: number): number {
    return Math.round(this.screenWidth * (pct / 100));
  }

  private pctToPixelY(pct: number): number {
    return Math.round(this.screenHeight * (pct / 100));
  }

  // ── W3C Actions Builder ───────────────────────────────────

  private async performActions(actions: unknown[]): Promise<void> {
    const resp = await this.sessionFetch('/actions', {
      method: 'POST',
      body: JSON.stringify({ actions }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`[WDA] Actions failed: ${text.slice(0, 200)}`);
    }
  }

  private pointerAction(steps: unknown[]): unknown {
    return {
      type: 'pointer',
      id: 'finger1',
      parameters: { pointerType: 'touch' },
      actions: steps,
    };
  }

  // ── Public Methods (same interface as MaestroClient) ──────

  hasBundleId(): boolean {
    return !!this.bundleId;
  }

  async launch(): Promise<void> {
    if (!this.bundleId) return;
    await this.launchApp(this.bundleId);
  }

  async launchApp(appId: string): Promise<void> {
    await this.sessionFetch('/wda/apps/launch', {
      method: 'POST',
      body: JSON.stringify({ bundleId: appId }),
    });
  }

  async stopApp(appId: string): Promise<void> {
    await this.sessionFetch('/wda/apps/terminate', {
      method: 'POST',
      body: JSON.stringify({ bundleId: appId }),
    });
  }

  async tap(x: number, y: number): Promise<void> {
    const px = this.pctToPixelX(x);
    const py = this.pctToPixelY(y);
    await this.performActions([
      this.pointerAction([
        { type: 'pointerMove', duration: 0, x: px, y: py },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 50 },
        { type: 'pointerUp', button: 0 },
      ]),
    ]);
  }

  async tapText(text: string): Promise<void> {
    // Try WDA element API first
    const elementId = await this.findElementByText(text);
    if (elementId) {
      await this.sessionFetch(`/element/${elementId}/click`, { method: 'POST', body: '{}' });
      return;
    }

    // Fallback: parse accessibility tree XML — required for CJK labels because
    // WDA's element search matches accessibilityIdentifier, not display text.
    const center = await this.findElementCenterByTextInTree(text);
    if (center) {
      await this.performActions([
        this.pointerAction([
          { type: 'pointerMove', duration: 0, x: center.x, y: center.y },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 50 },
          { type: 'pointerUp', button: 0 },
        ]),
      ]);
      return;
    }

    throw new Error(`[WDA] Element with text "${text}" not found`);
  }

  async doubleTap(x: number, y: number): Promise<void> {
    const px = this.pctToPixelX(x);
    const py = this.pctToPixelY(y);
    await this.performActions([
      this.pointerAction([
        { type: 'pointerMove', duration: 0, x: px, y: py },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerUp', button: 0 },
        { type: 'pause', duration: 50 },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerUp', button: 0 },
      ]),
    ]);
  }

  async longPress(x: number, y: number): Promise<void> {
    const px = this.pctToPixelX(x);
    const py = this.pctToPixelY(y);
    await this.performActions([
      this.pointerAction([
        { type: 'pointerMove', duration: 0, x: px, y: py },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 1000 },
        { type: 'pointerUp', button: 0 },
      ]),
    ]);
  }

  async longPressText(text: string): Promise<void> {
    let cx: number, cy: number;

    const elementId = await this.findElementByText(text);
    if (elementId) {
      const resp = await this.sessionFetch(`/element/${elementId}/rect`);
      const data = (await resp.json()) as { value?: { x?: number; y?: number; width?: number; height?: number } };
      const rect = data.value;
      if (!rect) throw new Error('[WDA] Could not get element rect');
      cx = Math.round((rect.x ?? 0) + (rect.width ?? 0) / 2);
      cy = Math.round((rect.y ?? 0) + (rect.height ?? 0) / 2);
    } else {
      const center = await this.findElementCenterByTextInTree(text);
      if (!center) throw new Error(`[WDA] Element with text "${text}" not found`);
      cx = center.x;
      cy = center.y;
    }

    await this.performActions([
      this.pointerAction([
        { type: 'pointerMove', duration: 0, x: cx, y: cy },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 1000 },
        { type: 'pointerUp', button: 0 },
      ]),
    ]);
  }

  async inputText(text: string): Promise<void> {
    await this.sessionFetch('/wda/keys', {
      method: 'POST',
      body: JSON.stringify({ value: [...text] }),
    });
  }

  async eraseText(chars: number = 50): Promise<void> {
    const deleteKeys = Array.from({ length: chars }, () => '\uE003');
    await this.sessionFetch('/wda/keys', {
      method: 'POST',
      body: JSON.stringify({ value: deleteKeys }),
    });
  }

  async scroll(): Promise<void> {
    await this.swipe(50, 70, 50, 30);
  }

  async swipe(startX: number, startY: number, endX: number, endY: number): Promise<void> {
    const sx = this.pctToPixelX(startX);
    const sy = this.pctToPixelY(startY);
    const ex = this.pctToPixelX(endX);
    const ey = this.pctToPixelY(endY);

    await this.performActions([
      this.pointerAction([
        { type: 'pointerMove', duration: 0, x: sx, y: sy },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerMove', duration: 300, x: ex, y: ey },
        { type: 'pointerUp', button: 0 },
      ]),
    ]);
  }

  async back(): Promise<void> {
    await this.iosBackGesture();
  }

  async iosBackGesture(): Promise<void> {
    await this.swipe(1, 50, 80, 50);
  }

  async hideKeyboard(): Promise<void> {
    try {
      await this.sessionFetch('/wda/keyboard/dismiss', { method: 'POST', body: '{}' });
    } catch {
      await this.tap(50, 10);
    }
  }

  async openLink(url: string): Promise<void> {
    await this.sessionFetch('/url', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  }

  async pressKey(key: string): Promise<void> {
    const keyMap: Record<string, string> = {
      enter: '\uE007',
      return: '\uE007',
      delete: '\uE003',
      backspace: '\uE003',
      tab: '\uE004',
      escape: '\uE00C',
      space: ' ',
      home: '\uE011',
    };
    const value = keyMap[key.toLowerCase()] ?? key;
    await this.sessionFetch('/wda/keys', {
      method: 'POST',
      body: JSON.stringify({ value: [value] }),
    });
  }

  async waitForAnimation(timeout: number = 3000): Promise<void> {
    await sleep(timeout);
  }

  // ── MobileDevice interface methods ──────────────────────────

  async connect(): Promise<void> {
    return this.start();
  }

  async disconnect(): Promise<void> {
    return this.stop();
  }

  isConnected(): boolean {
    return this.sessionId !== null;
  }

  screenSize(): { width: number; height: number } {
    return { width: this.screenWidth, height: this.screenHeight };
  }

  async screenshot(): Promise<Buffer> {
    if (!this.sessionId) throw new Error('[WDA] No active session');

    const resp = await this.sessionFetch('/screenshot');
    const data = (await resp.json()) as { value?: string };
    const base64 = data.value;
    if (!base64) throw new Error('[WDA] Screenshot returned no data');

    return Buffer.from(base64, 'base64');
  }

  /** Screenshot as base64 string — used by executor/agent legacy path */
  async screenshotBase64(stepNumber?: number): Promise<string> {
    if (!this.sessionId) throw new Error('[WDA] No active session');

    const resp = await this.sessionFetch('/screenshot');
    const data = (await resp.json()) as { value?: string };
    const base64 = data.value;
    if (!base64) throw new Error('[WDA] Screenshot returned no data');

    if (this.saveEvalScreens && stepNumber !== undefined) {
      mkdirSync(this.evalScreensDir, { recursive: true });
      const evalPath = path.join(
        this.evalScreensDir,
        `step-${String(stepNumber).padStart(3, '0')}-before.png`
      );
      writeFileSync(evalPath, Buffer.from(base64, 'base64'));
    }

    return base64;
  }

  async accessibilityTree(): Promise<string> {
    const resp = await this.sessionFetch('/source');
    const data = (await resp.json()) as { value?: string };
    return data.value ?? '';
  }

  /** @deprecated Use accessibilityTree() instead */
  async getAccessibilityTree(): Promise<string> {
    return this.accessibilityTree();
  }

  // ── Element Finding ───────────────────────────────────────

  private async findElementByText(text: string): Promise<string | null> {
    const strategies = [
      { using: '-ios predicate string', value: `label CONTAINS[c] '${text.replace(/'/g, "\\'")}'` },
      { using: 'link text', value: text },
      { using: 'name', value: text },
    ];

    for (const strategy of strategies) {
      try {
        const resp = await this.sessionFetch('/element', {
          method: 'POST',
          body: JSON.stringify(strategy),
        });
        if (!resp.ok) continue;
        const data = (await resp.json()) as { value?: { ELEMENT?: string } };
        const eid = data.value?.ELEMENT;
        if (eid) return eid;
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * Parse the accessibility tree XML to find an element by its display text
   * (label, name, or value attribute). Returns pixel center coordinates.
   *
   * This is the reliable path for CJK text: WDA's element search API matches
   * against accessibilityIdentifier (usually ASCII), while the XML tree contains
   * the actual displayed label with full Unicode fidelity.
   */
  private async findElementCenterByTextInTree(
    text: string
  ): Promise<{ x: number; y: number } | null> {
    const xml = await this.accessibilityTree();

    const decodeEntities = (s: string) =>
      s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

    const getAttr = (attrs: string, name: string): string | null => {
      const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
      return m ? decodeEntities(m[1]!) : null;
    };

    const elementRegex = /<XCUIElementType\w+\s+([^>]*?)\/?\s*>/g;
    let match;

    while ((match = elementRegex.exec(xml)) !== null) {
      const attrs = match[1]!;
      if (getAttr(attrs, 'visible') === 'false') continue;

      const label = getAttr(attrs, 'label') ?? '';
      const name = getAttr(attrs, 'name') ?? '';
      const value = getAttr(attrs, 'value') ?? '';

      const found = [label, name, value].some(
        (v) => v === text || v.toLowerCase().includes(text.toLowerCase())
      );
      if (!found) continue;

      const x = getAttr(attrs, 'x');
      const y = getAttr(attrs, 'y');
      const w = getAttr(attrs, 'width');
      const h = getAttr(attrs, 'height');

      if (x && y && w && h) {
        return {
          x: parseInt(x, 10) + Math.round(parseInt(w, 10) / 2),
          y: parseInt(y, 10) + Math.round(parseInt(h, 10) / 2),
        };
      }
    }

    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
