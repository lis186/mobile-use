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
 *   agent <task>        — AI agent loop: screenshot → AI reason → execute → repeat
 *                         e.g., agent "open Settings and toggle Dark Mode"
 *                         Options: --app <bundleId> to launch app first
 *                                  --max-steps <n> (default: 30)
 *                                  --model <name> (default: auto-detect)
 */

import 'dotenv/config';
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

// ── Agent Mode ──────────────────────────────────

interface AgentDecision {
  action: string;
  params?: Record<string, unknown>;
  reasoning: string;
  progress: number;
}

function buildAgentSystemPrompt(task: string, step: number, maxSteps: number, history: string[]): string {
  return `You are an AI agent controlling a real iPhone via WDA (WebDriverAgent).

OBJECTIVE: ${task}

COORDINATE GUIDE — estimate tap positions as PERCENTAGES (0-100):
- 0% = left/top edge, 50% = center, 100% = right/bottom edge
- Tab bar items: y ~93-96%, x varies by position
- Nav back arrow: x ~5-10%, y ~6-8%
- Top-right button: x ~90-95%, y ~6-8%
- FAB (+): typically x ~85%, y ~85%

AVAILABLE ACTIONS (respond with ONLY valid JSON, no markdown):

tap: {"action":"tap","params":{"x":50,"y":50},"reasoning":"...","progress":N}
tapText: {"action":"tapText","params":{"text":"Button Label"},"reasoning":"...","progress":N}
inputText: {"action":"inputText","params":{"text":"hello"},"reasoning":"...","progress":N}
scroll: {"action":"scroll","params":{},"reasoning":"...","progress":N}
swipe: {"action":"swipe","params":{"startX":50,"startY":80,"endX":50,"endY":20},"reasoning":"...","progress":N}
back: {"action":"back","params":{},"reasoning":"...","progress":N}
home: {"action":"home","params":{},"reasoning":"...","progress":N}
launch: {"action":"launch","params":{"bundleId":"com.example.app"},"reasoning":"...","progress":N}
wait: {"action":"wait","params":{},"reasoning":"...","progress":N}
done: {"action":"done","params":{},"reasoning":"Task completed because...","progress":100}
failed: {"action":"failed","params":{},"reasoning":"Cannot complete because...","progress":N}

RULES:
- Prefer tapText when you see readable text on a button
- Use tap coordinates when tapText might fail (icons, images)
- Only inputText AFTER tapping a text field (cursor/keyboard visible)
- If stuck (same action 2+ times), try completely different approach

PROGRESS: Step ${step}/${maxSteps}
Recent actions: ${history.slice(-5).join(' → ') || 'none'}

Respond with ONLY valid JSON.`;
}

async function getScreenshotBase64(): Promise<string> {
  const resp = await sessionFetch('/screenshot');
  const data = (await resp.json()) as { value?: string };
  if (!data.value) throw new Error('No screenshot data');
  return data.value;
}

async function executeAgentAction(decision: AgentDecision): Promise<string> {
  const p = decision.params ?? {};
  switch (decision.action) {
    case 'tap':
      await cmdTap(Number(p.x ?? 50), Number(p.y ?? 50));
      return `tap(${p.x},${p.y})`;
    case 'tapText':
      await cmdTapText(String(p.text ?? ''));
      return `tapText("${String(p.text ?? '').slice(0, 20)}")`;
    case 'inputText':
      await cmdType(String(p.text ?? ''));
      return `inputText("${String(p.text ?? '').slice(0, 20)}")`;
    case 'scroll':
      await cmdSwipe(50, 70, 50, 30);
      return 'scroll';
    case 'swipe':
      await cmdSwipe(Number(p.startX ?? 50), Number(p.startY ?? 80), Number(p.endX ?? 50), Number(p.endY ?? 20));
      return `swipe(${p.startX},${p.startY}→${p.endX},${p.endY})`;
    case 'back':
      await cmdBack();
      return 'back';
    case 'home':
      await cmdHome();
      return 'home';
    case 'launch':
      await cmdLaunch(String(p.bundleId ?? ''));
      return `launch(${p.bundleId})`;
    case 'wait':
      await new Promise((r) => setTimeout(r, 2000));
      return 'wait';
    default:
      return decision.action;
  }
}

async function cmdAgent(task: string, options: { app?: string; maxSteps?: number; model?: string }) {
  const maxSteps = options.maxSteps ?? 30;

  // Auto-detect AI provider from env
  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!googleKey && !openaiKey) {
    console.error('No API key. Set GOOGLE_GENERATIVE_AI_API_KEY or OPENAI_API_KEY');
    process.exit(1);
  }

  // Dynamic import to keep startup fast for non-agent commands
  const { generateText } = await import('ai');
  let getModel: () => unknown;

  if (googleKey) {
    const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
    const google = createGoogleGenerativeAI({ apiKey: googleKey });
    const modelName = options.model ?? 'gemini-2.5-flash';
    getModel = () => google(modelName);
    console.log(`AI: Google ${modelName}`);
  } else {
    const { createOpenAI } = await import('@ai-sdk/openai');
    const openai = createOpenAI({ apiKey: openaiKey! });
    const modelName = options.model ?? 'gpt-4o';
    getModel = () => openai(modelName);
    console.log(`AI: OpenAI ${modelName}`);
  }

  console.log(`Task: ${task}`);
  console.log(`Max steps: ${maxSteps}\n`);

  // Launch app if specified
  if (options.app) {
    await cmdLaunch(options.app);
    await new Promise((r) => setTimeout(r, 2000));
  }

  const history: string[] = [];
  const conversationHistory: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];

  for (let step = 1; step <= maxSteps; step++) {
    console.log(`\n${'─'.repeat(40)}`);
    console.log(`Step ${step}/${maxSteps}`);

    // Screenshot
    let base64: string;
    try {
      base64 = await getScreenshotBase64();
    } catch (e) {
      console.error(`Screenshot failed: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    // Build AI message
    const systemPrompt = buildAgentSystemPrompt(task, step, maxSteps, history);
    const userMsg = {
      role: 'user' as const,
      content: [
        { type: 'image' as const, image: Buffer.from(base64, 'base64') },
        { type: 'text' as const, text: 'Analyze the screenshot. What is the ONE best action?' },
      ],
    };

    // Trim conversation history to prevent token overflow
    if (conversationHistory.length > 10) {
      conversationHistory.splice(0, conversationHistory.length - 8);
    }
    conversationHistory.push(userMsg);

    // Ask AI
    let decision: AgentDecision;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (generateText as any)({
        model: getModel(),
        system: systemPrompt,
        messages: conversationHistory,
      });

      conversationHistory.push({ role: 'assistant', content: response.text });

      const jsonMatch = response.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in AI response');
      decision = JSON.parse(jsonMatch[0]) as AgentDecision;
    } catch (e) {
      console.error(`AI error: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    console.log(`  Thinking: ${decision.reasoning}`);
    console.log(`  Progress: ${decision.progress}%`);
    console.log(`  Action: ${decision.action} ${decision.params ? JSON.stringify(decision.params) : ''}`);

    // Handle terminal actions
    if (decision.action === 'done') {
      console.log(`\n${'═'.repeat(50)}`);
      console.log(`SUCCESS — ${decision.reasoning}`);
      console.log(`Steps: ${step}`);
      console.log('═'.repeat(50));
      return;
    }
    if (decision.action === 'failed') {
      console.log(`\n${'═'.repeat(50)}`);
      console.log(`FAILED — ${decision.reasoning}`);
      console.log(`Steps: ${step}`);
      console.log('═'.repeat(50));
      process.exit(1);
    }

    // Execute action
    try {
      const actionStr = await executeAgentAction(decision);
      history.push(actionStr);
    } catch (e) {
      console.error(`  Action failed: ${(e as Error).message}`);
      history.push('error');
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`TIMEOUT — Max steps (${maxSteps}) reached`);
  console.log('═'.repeat(50));
  process.exit(1);
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
    case 'agent': {
      // Parse agent options: agent [--app bundleId] [--max-steps N] [--model name] <task...>
      let app: string | undefined;
      let maxSteps: number | undefined;
      let model: string | undefined;
      const taskParts: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--app' && args[i + 1]) { app = args[++i]; }
        else if (args[i] === '--max-steps' && args[i + 1]) { maxSteps = Number(args[++i]); }
        else if (args[i] === '--model' && args[i + 1]) { model = args[++i]; }
        else { taskParts.push(args[i]!); }
      }
      const agentTask = taskParts.join(' ');
      if (!agentTask) {
        console.error('Usage: agent [--app <bundleId>] [--max-steps <n>] [--model <name>] <task>');
        process.exit(1);
      }
      await cmdAgent(agentTask, { app, maxSteps, model });
      break;
    }
    case 'do': {
      const includeSource = args[0] === '--source';
      const doArgs = includeSource ? args.slice(1) : args;
      await cmdDo(doArgs, includeSource);
      break;
    }
    default:
      console.log('Commands: start, screenshot/ss, tap, tapText/tt, type, swipe, scroll, launch, home, back, source, do, list-apps, agent');
  }
} catch (e) {
  console.error('Error:', (e as Error).message);
}
