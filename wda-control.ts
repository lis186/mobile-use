/**
 * Interactive WDA control script — run actions via command line args.
 * Usage: npx tsx wda-control.ts <command> [args...]
 *
 * Commands:
 *   start             — Start WDA + create session (run once first)
 *   screenshot        — Take screenshot and save to /tmp/wda-screen.png
 *   tap <x%> <y%>     — Tap at percentage coordinates
 *   tapText <text>    — Find element by text and tap it
 *   type <text>       — Input text
 *   swipe <sx> <sy> <ex> <ey> — Swipe (percentage coords)
 *   scroll            — Scroll down
 *   launch <bundleId> — Launch app
 *   home              — Go to home screen
 *   back              — iOS back gesture (swipe from left)
 *   source            — Dump UI element tree (accessibility hierarchy)
 *   do <action> [args] — Execute action + wait 1s + screenshot
 *                        e.g., do tap 50 50 / do scroll / do tapText Settings
 *   do --source <action> [args] — Same as do, but also dumps UI source
 *   list-apps [filter]  — List installed apps (optional text filter, needs ideviceinstaller)
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';

const PORT = 8100;
const BASE = `http://localhost:${PORT}`;
const SESSION_FILE = '/tmp/wda-session.json';

interface SessionInfo {
  sessionId: string;
  width: number;
  height: number;
}

async function wdaFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
}

async function getSession(): Promise<SessionInfo> {
  if (!existsSync(SESSION_FILE)) {
    throw new Error('No session. Run: npx tsx wda-control.ts start');
  }
  return JSON.parse(readFileSync(SESSION_FILE, 'utf-8')) as SessionInfo;
}

async function sessionFetch(subpath: string, init?: RequestInit): Promise<Response> {
  const s = await getSession();
  return wdaFetch(`/session/${s.sessionId}${subpath}`, init);
}

// ── Commands ────────────────────────────────────

async function cmdStart() {
  // Check if WDA is already running
  try {
    const resp = await fetch(`${BASE}/status`);
    if (!resp.ok) throw new Error('not ready');
  } catch {
    console.error('WDA not running. Start it first:\n  iproxy 8100 8100 -u 00008130-001619A80E30001C &\n  xcodebuild test-without-building -project /tmp/WebDriverAgent/WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner -destination id=00008130-001619A80E30001C DEVELOPMENT_TEAM=E3KVH5A433 USE_PORT=8100 &');
    process.exit(1);
  }

  // Create session
  const resp = await wdaFetch('/session', {
    method: 'POST',
    body: JSON.stringify({ capabilities: {} }),
  });
  const data = (await resp.json()) as { value?: { sessionId?: string }; sessionId?: string };
  const sessionId = data.value?.sessionId ?? data.sessionId;
  if (!sessionId) throw new Error('Failed to create session');

  // Get screen size
  const sizeResp = await wdaFetch(`/session/${sessionId}/window/size`);
  const sizeData = (await sizeResp.json()) as { value?: { width?: number; height?: number } };
  const width = sizeData.value?.width ?? 430;
  const height = sizeData.value?.height ?? 932;

  const info: SessionInfo = { sessionId, width, height };
  writeFileSync(SESSION_FILE, JSON.stringify(info));
  console.log(`Session: ${sessionId}, Screen: ${width}x${height}`);
}

async function cmdScreenshot() {
  const resp = await sessionFetch('/screenshot');
  const data = (await resp.json()) as { value?: string };
  if (!data.value) throw new Error('No screenshot data');
  writeFileSync('/tmp/wda-screen.png', Buffer.from(data.value, 'base64'));
  console.log('Saved: /tmp/wda-screen.png');
}

async function cmdTap(xPct: number, yPct: number) {
  const s = await getSession();
  const x = Math.round(s.width * (xPct / 100));
  const y = Math.round(s.height * (yPct / 100));
  await sessionFetch('/actions', {
    method: 'POST',
    body: JSON.stringify({
      actions: [{
        type: 'pointer', id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x, y },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 50 },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    }),
  });
  console.log(`Tapped: ${xPct}%,${yPct}% → pixel ${x},${y}`);
}

async function cmdTapText(text: string) {
  const strategies = [
    { using: '-ios predicate string', value: `label CONTAINS[c] '${text.replace(/'/g, "\\'")}'` },
    { using: 'name', value: text },
  ];
  for (const strategy of strategies) {
    try {
      const resp = await sessionFetch('/element', {
        method: 'POST',
        body: JSON.stringify(strategy),
      });
      if (!resp.ok) continue;
      const data = (await resp.json()) as { value?: { ELEMENT?: string } };
      const eid = data.value?.ELEMENT;
      if (eid) {
        await sessionFetch(`/element/${eid}/click`, { method: 'POST', body: '{}' });
        console.log(`Tapped element: "${text}"`);
        return;
      }
    } catch { continue; }
  }
  console.error(`Element not found: "${text}"`);
}

async function cmdType(text: string) {
  await sessionFetch('/wda/keys', {
    method: 'POST',
    body: JSON.stringify({ value: [...text] }),
  });
  console.log(`Typed: "${text}"`);
}

async function cmdSwipe(sx: number, sy: number, ex: number, ey: number) {
  const s = await getSession();
  await sessionFetch('/actions', {
    method: 'POST',
    body: JSON.stringify({
      actions: [{
        type: 'pointer', id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: Math.round(s.width * sx / 100), y: Math.round(s.height * sy / 100) },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration: 300, x: Math.round(s.width * ex / 100), y: Math.round(s.height * ey / 100) },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    }),
  });
  console.log(`Swiped: ${sx}%,${sy}% → ${ex}%,${ey}%`);
}

async function cmdLaunch(bundleId: string) {
  await sessionFetch('/wda/apps/launch', {
    method: 'POST',
    body: JSON.stringify({ bundleId }),
  });
  console.log(`Launched: ${bundleId}`);
}

async function cmdHome() {
  await wdaFetch('/wda/homescreen', { method: 'POST', body: '{}' });
  console.log('Home screen');
}

async function cmdBack() {
  await cmdSwipe(1, 50, 80, 50);
}

async function cmdListApps(filter?: string) {
  try {
    const output = execFileSync('ideviceinstaller', ['list', '--user'], { encoding: 'utf-8' });
    const lines = output.trim().split('\n');
    const filtered = filter
      ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
      : lines;
    console.log(filtered.join('\n'));
    console.log(`\n${filtered.length} app(s)${filter ? ` matching "${filter}"` : ''}`);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('ENOENT')) {
      console.error('ideviceinstaller not found. Install with: brew install ideviceinstaller');
    } else {
      console.error('Error listing apps:', msg.slice(0, 300));
    }
  }
}

async function cmdSource() {
  const s = await getSession();
  const resp = await wdaFetch(`/session/${s.sessionId}/source`);
  const data = (await resp.json()) as { value?: string };
  if (!data.value) throw new Error('No source data');
  console.log(data.value);
}

async function runAction(action: string, actionArgs: string[]): Promise<void> {
  switch (action) {
    case 'tap': await cmdTap(Number(actionArgs[0]), Number(actionArgs[1])); break;
    case 'tapText': case 'tt': await cmdTapText(actionArgs.join(' ')); break;
    case 'type': await cmdType(actionArgs.join(' ')); break;
    case 'swipe': await cmdSwipe(Number(actionArgs[0]), Number(actionArgs[1]), Number(actionArgs[2]), Number(actionArgs[3])); break;
    case 'scroll': await cmdSwipe(50, 70, 50, 30); break;
    case 'launch': await cmdLaunch(actionArgs[0]!); break;
    case 'home': await cmdHome(); break;
    case 'back': await cmdBack(); break;
    default: throw new Error(`Unknown action: ${action}`);
  }
}

async function cmdDo(actionArgs: string[], includeSource: boolean) {
  // Parse --source flag
  const action = actionArgs[0];
  const rest = actionArgs.slice(1);
  if (!action) {
    console.error('Usage: do [--source] <action> [args...]');
    return;
  }

  // Execute the action
  await runAction(action, rest);

  // Wait for animation
  await new Promise((r) => setTimeout(r, 1000));

  // Take screenshot
  await cmdScreenshot();

  // Optionally dump UI source
  if (includeSource) {
    console.log('\n── UI Source ──────────────────────────────────');
    await cmdSource();
  }
}

// ── Main ────────────────────────────────────────
const [cmd, ...args] = process.argv.slice(2);

try {
  switch (cmd) {
    case 'start': await cmdStart(); break;
    case 'screenshot': case 'ss': await cmdScreenshot(); break;
    case 'tap': await cmdTap(Number(args[0]), Number(args[1])); break;
    case 'tapText': case 'tt': await cmdTapText(args.join(' ')); break;
    case 'type': await cmdType(args.join(' ')); break;
    case 'swipe': await cmdSwipe(Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3])); break;
    case 'scroll': await cmdSwipe(50, 70, 50, 30); break;
    case 'launch': await cmdLaunch(args[0]!); break;
    case 'home': await cmdHome(); break;
    case 'back': await cmdBack(); break;
    case 'source': await cmdSource(); break;
    case 'list-apps': await cmdListApps(args[0]); break;
    case 'do': {
      const includeSource = args[0] === '--source';
      const doArgs = includeSource ? args.slice(1) : args;
      await cmdDo(doArgs, includeSource);
      break;
    }
    default:
      console.log('Commands: start, screenshot/ss, tap, tapText/tt, type, swipe, scroll, launch, home, back, source, do, list-apps');
  }
} catch (e) {
  console.error('Error:', (e as Error).message);
}
