/**
 * LiveViewer — opt-in local HTTP server that streams each step's screenshot
 * and AI decision to a browser in real-time via Server-Sent Events.
 *
 * Zero overhead when not enabled: the module is dynamically imported only
 * when --live is passed.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import sharp from 'sharp';

export interface StepData {
  step: number;
  maxSteps: number;
  screenshotBase64: string;
  action: string;
  reasoning: string;
  progress: number;
  params?: Record<string, unknown>;
}

export interface DoneData {
  success: boolean;
  reason: string;
  steps: number;
}

export class LiveViewer {
  private port: number;
  private server: Server | null = null;
  private clients = new Set<ServerResponse>();
  private steps = new Map<number, Buffer>();
  private stepMeta: Array<Omit<StepData, 'screenshotBase64'> & { timestamp: number }> = [];
  private doneResult: DoneData | null = null;
  private taskName = '';

  constructor(port = 7330) {
    this.port = port;
  }

  setTaskName(name: string): void {
    this.taskName = name;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Live viewer port ${this.port} is already in use`));
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        resolve();
      });
    });
  }

  async pushStep(data: StepData): Promise<void> {
    // Compress screenshot to JPEG
    const raw = Buffer.from(data.screenshotBase64, 'base64');
    const metadata = await sharp(raw).metadata();
    const targetWidth = Math.round((metadata.width ?? 800) / 2);
    const jpeg = await sharp(raw).resize(targetWidth).jpeg({ quality: 80 }).toBuffer();

    this.steps.set(data.step, jpeg);

    const meta = {
      step: data.step,
      maxSteps: data.maxSteps,
      action: data.action,
      reasoning: data.reasoning,
      progress: data.progress,
      params: data.params,
      timestamp: Date.now(),
    };
    this.stepMeta.push(meta);

    this.broadcast('step', meta);
  }

  pushDone(result: DoneData): void {
    this.doneResult = result;
    this.broadcast('done', result);
  }

  async stop(): Promise<void> {
    // Close all SSE connections
    for (const client of this.clients) {
      try { client.end(); } catch { /* ignore */ }
    }
    this.clients.clear();

    // Close server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
        // Force-close after 2s
        setTimeout(() => resolve(), 2000);
      });
      this.server = null;
    }
  }

  get url(): string {
    return `http://localhost:${this.port}`;
  }

  // ── Request Handler ──────────────────────────────────────

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/';

    if (url === '/') {
      this.serveHtml(res);
    } else if (url === '/events') {
      this.serveSSE(req, res);
    } else if (url.startsWith('/step/')) {
      this.serveScreenshot(url, res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  }

  private serveHtml(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getHtml());
  }

  private serveSSE(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send existing steps as replay
    for (const meta of this.stepMeta) {
      res.write(`event: step\ndata: ${JSON.stringify(meta)}\n\n`);
    }
    if (this.doneResult) {
      res.write(`event: done\ndata: ${JSON.stringify(this.doneResult)}\n\n`);
    }

    // Send task name
    if (this.taskName) {
      res.write(`event: init\ndata: ${JSON.stringify({ task: this.taskName })}\n\n`);
    }

    this.clients.add(res);

    req.on('close', () => {
      this.clients.delete(res);
    });
  }

  private serveScreenshot(url: string, res: ServerResponse): void {
    const stepStr = url.slice('/step/'.length);
    const step = parseInt(stepStr, 10);

    const jpeg = this.steps.get(step);
    if (!jpeg) {
      res.writeHead(404);
      res.end('Step not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(jpeg.length),
    });
    res.end(jpeg);
  }

  private broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try { client.write(payload); } catch { /* ignore dead connections */ }
    }
  }
}

// ── Inline HTML ────────────────────────────────────────────

function getHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>phone-use Live Viewer</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: #0f0f1a;
    color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Top Bar ────────────────────────── */
  .top-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 20px;
    background: #1a1a2e;
    border-bottom: 1px solid #2a2a3e;
    flex-shrink: 0;
  }

  .live-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #4ade80;
  }

  .live-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #4ade80;
    animation: pulse 1.5s ease-in-out infinite;
  }

  .live-badge.done .live-dot {
    background: #666;
    animation: none;
  }

  .live-badge.done { color: #666; }

  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.8); }
  }

  .task-name {
    font-size: 14px;
    color: #888;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .step-counter {
    font-size: 13px;
    color: #888;
    font-variant-numeric: tabular-nums;
  }

  /* ── Main Area ──────────────────────── */
  .main-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 16px;
    gap: 12px;
  }

  .screen-container {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 0;
    position: relative;
  }

  .screen-container img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: 12px;
    border: 2px solid #2a2a3e;
  }

  .screen-placeholder {
    color: #444;
    font-size: 16px;
    text-align: center;
  }

  .screen-placeholder .icon { font-size: 48px; margin-bottom: 12px; }

  /* ── Info Bar ──────────────────────── */
  .info-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    background: #1a1a2e;
    border-radius: 8px;
    font-size: 13px;
    flex-shrink: 0;
    min-height: 44px;
  }

  .info-action {
    font-weight: 600;
    color: #60a5fa;
    white-space: nowrap;
  }

  .info-reasoning {
    color: #888;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .info-progress {
    font-variant-numeric: tabular-nums;
    color: #4ade80;
    white-space: nowrap;
  }

  /* ── Thumbnail Strip ────────────────── */
  .thumb-strip {
    display: flex;
    gap: 8px;
    padding: 12px 20px;
    background: #1a1a2e;
    border-top: 1px solid #2a2a3e;
    overflow-x: auto;
    flex-shrink: 0;
    scrollbar-width: thin;
    scrollbar-color: #333 transparent;
  }

  .thumb-strip::-webkit-scrollbar { height: 6px; }
  .thumb-strip::-webkit-scrollbar-track { background: transparent; }
  .thumb-strip::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }

  .thumb {
    flex-shrink: 0;
    width: 56px;
    height: 100px;
    border-radius: 6px;
    border: 2px solid transparent;
    overflow: hidden;
    cursor: pointer;
    position: relative;
    transition: border-color 0.15s;
  }

  .thumb:hover { border-color: #444; }
  .thumb.active { border-color: #60a5fa; }

  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .thumb-badge {
    position: absolute;
    top: 2px;
    left: 2px;
    background: rgba(0,0,0,0.7);
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
  }

  /* ── Done Banner ────────────────────── */
  .done-banner {
    display: none;
    position: fixed;
    bottom: 100px;
    left: 50%;
    transform: translateX(-50%);
    padding: 12px 24px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    z-index: 10;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
  }

  .done-banner.success {
    background: #166534;
    color: #4ade80;
    display: block;
  }

  .done-banner.failure {
    background: #7f1d1d;
    color: #fca5a5;
    display: block;
  }
</style>
</head>
<body>

<div class="top-bar">
  <div class="live-badge" id="liveBadge">
    <div class="live-dot"></div>
    LIVE
  </div>
  <div class="task-name" id="taskName">Waiting for task...</div>
  <div class="step-counter" id="stepCounter">-</div>
</div>

<div class="main-area">
  <div class="screen-container" id="screenContainer">
    <div class="screen-placeholder">
      <div class="icon">&#128241;</div>
      Waiting for first screenshot...
    </div>
  </div>
  <div class="info-bar" id="infoBar">
    <span class="info-action" id="infoAction">-</span>
    <span class="info-reasoning" id="infoReasoning">Waiting...</span>
    <span class="info-progress" id="infoProgress">-</span>
  </div>
</div>

<div class="thumb-strip" id="thumbStrip"></div>

<div class="done-banner" id="doneBanner"></div>

<script>
(function() {
  const screenContainer = document.getElementById('screenContainer');
  const thumbStrip = document.getElementById('thumbStrip');
  const stepCounter = document.getElementById('stepCounter');
  const infoAction = document.getElementById('infoAction');
  const infoReasoning = document.getElementById('infoReasoning');
  const infoProgress = document.getElementById('infoProgress');
  const liveBadge = document.getElementById('liveBadge');
  const taskName = document.getElementById('taskName');
  const doneBanner = document.getElementById('doneBanner');

  let trackingLatest = true;
  let currentStep = 0;
  const steps = {};

  function selectStep(step) {
    const meta = steps[step];
    if (!meta) return;

    currentStep = step;

    // Update main image
    screenContainer.innerHTML = '<img src="/step/' + step + '" alt="Step ' + step + '">';

    // Update info bar
    infoAction.textContent = meta.action;
    infoReasoning.textContent = meta.reasoning;
    infoProgress.textContent = meta.progress + '%';
    stepCounter.textContent = 'Step ' + meta.step + '/' + meta.maxSteps;

    // Update active thumb
    document.querySelectorAll('.thumb').forEach(function(t) {
      t.classList.toggle('active', parseInt(t.dataset.step) === step);
    });
  }

  function addThumb(meta) {
    const div = document.createElement('div');
    div.className = 'thumb' + (trackingLatest ? ' active' : '');
    div.dataset.step = meta.step;
    div.innerHTML = '<img src="/step/' + meta.step + '" alt="Step ' + meta.step + '">'
      + '<div class="thumb-badge">' + meta.step + '</div>';

    div.addEventListener('click', function() {
      trackingLatest = false;
      selectStep(meta.step);
    });

    thumbStrip.appendChild(div);

    // Auto-scroll to latest
    thumbStrip.scrollLeft = thumbStrip.scrollWidth;
  }

  const es = new EventSource('/events');

  es.addEventListener('init', function(e) {
    const data = JSON.parse(e.data);
    if (data.task) taskName.textContent = data.task;
  });

  es.addEventListener('step', function(e) {
    const meta = JSON.parse(e.data);
    steps[meta.step] = meta;
    addThumb(meta);

    if (trackingLatest) {
      selectStep(meta.step);
    }
  });

  es.addEventListener('done', function(e) {
    const data = JSON.parse(e.data);
    liveBadge.classList.add('done');

    doneBanner.textContent = data.success
      ? 'Task completed successfully (' + data.steps + ' steps)'
      : 'Task failed: ' + data.reason;
    doneBanner.className = 'done-banner ' + (data.success ? 'success' : 'failure');
  });

  // Double-click main image to re-enable tracking
  screenContainer.addEventListener('dblclick', function() {
    trackingLatest = true;
    if (Object.keys(steps).length > 0) {
      const latest = Math.max.apply(null, Object.keys(steps).map(Number));
      selectStep(latest);
    }
  });
})();
</script>

</body>
</html>`;
}
