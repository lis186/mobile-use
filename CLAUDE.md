# Mobile Use — Development Guide

AI-powered mobile task automation. Natural language → screenshot → AI decision → device action loop.

## Project Structure

- `src/index.ts` — CLI entry point (commander), including the `audit` subcommand
- `src/executor.ts` — Task execution loop (observe → decide → execute → repeat)
- `src/agent.ts` — AI agent (vision model integration)
- `src/audit-executor.ts` — Autonomous audit loop (extends TaskExecutor, Phase 1)
- `src/audit-agent.ts` — Stateless audit agent (extends TaskAgent, Phase 1)
- `src/audit-report.ts` — Markdown report renderer for audit output
- `src/schemas/audit.ts` — Zod schema for `AuditDecision` (structured output)
- `src/core/` — Audit support modules (fingerprint, rate limiter, annotation, timing, JSONL)
- `src/errors/audit-errors.ts` — `AuditError` class + 9 discriminated error codes
- `src/wda.ts` — WDAClient for physical iOS devices
- `src/maestro.ts` — MaestroClient for simulators
- `src/xctest.ts` — XCTest runner for iOS 26+ simulators
- `src/types.ts` — Shared types (`RunnerType`, `TaskConfig`, `AuditConfig`, etc.)

### When to use which command

| Command | Input | Use when |
|---------|-------|----------|
| `phone-use run <bundleId> <task>` | a specific, goal-oriented task in natural language | you know exactly what you want the phone to do (send a message, fill a form, book a seat). Conversation-history-aware agent; best for ≤ 100-step tasks with a clear end condition. |
| `phone-use audit <bundleId>` | **no task** — just a bundle id (and optionally `--scope`) | you want the agent to explore the app on its own and emit a Markdown UX audit with annotated screenshots. Stateless, Norman/Nielsen/HIG-grounded, produces `report.md` + `annotated/step-NN.jpg`. Supports iOS 26 simulator (`--runner xctest`) and real devices (`--runner wda`). |

**Known limitations**:
- Audit mode assumes Gemini 2.5 Flash as the default vision model. Free-tier quota (both RPM and RPD) will throttle or block long runs — see `openspec/changes/add-mobile-ux-audit/handoff.md` §4 for the latest observed behaviour and recommended `--rpm-limit` / `--max-retries` settings.
- For real device audit: WDA must already be running (see WDA Runner section below). Pass `--runner wda --ios-device <UDID> --team-id <TEAM_ID>`.
- Run mode (`phone-use run`) is unchanged by the audit work: `src/agent.ts` and `src/executor.ts` only received visibility bumps (`private → protected`) and a shared driver-build helper. No behavioural change. See `openspec/changes/add-mobile-ux-audit/handoff.md` §8.4.

## Build & Run

```bash
npm run build          # tsup → dist/
npm run dev            # tsx src/index.ts (dev mode)
npx tsx src/index.ts run <bundleId> --task "..." --runner <runner>
```

## Runner Selection (Critical)

| Runner | Target | Notes |
|--------|--------|-------|
| `maestro` | iOS Simulator (≤18.x) | Default, works out of the box |
| `xctest` | iOS Simulator (26+) | For newer simulators |
| `wda` | **Physical iPhone** | Recommended for real devices |
| `maestro-runner` | Physical iPhone | **BROKEN** — tap fails due to missing WDA session, avoid |

### WDA Runner for Physical Devices

WDA must be running before `phone-use`. It does NOT auto-start.

```bash
# 1. Build WDA (once per Xcode version)
xcodebuild build-for-testing \
  -project ~/.maestro-runner/drivers/ios/WebDriverAgent/WebDriverAgent.xcodeproj \
  -scheme WebDriverAgentRunner \
  -destination "generic/platform=iOS" \
  DEVELOPMENT_TEAM=<TEAM_ID> \
  "CODE_SIGN_IDENTITY=Apple Development" \
  USE_PORT=8100

# 2. Start WDA + port forwarding
xcodebuild test-without-building \
  -project ~/.maestro-runner/drivers/ios/WebDriverAgent/WebDriverAgent.xcodeproj \
  -scheme WebDriverAgentRunner \
  -destination "id=<DEVICE_UDID>" \
  DEVELOPMENT_TEAM=<TEAM_ID> \
  USE_PORT=8100 &

iproxy 8100 8100 -u <DEVICE_UDID> &

# 3. Verify
curl -s http://localhost:8100/status | python3 -m json.tool
```

Once WDA is running, `WDAClient.start()` auto-detects and connects.

## Known Issues

### `tapText` fails for CJK characters — **FIXED**
~~WDA element search often can't find CJK labels.~~ `WDAClient` now falls back to
parsing the accessibility tree XML directly, which contains full Unicode labels with
pixel coordinates. `tapText("天氣")` works reliably on real devices.

### iproxy POST forwarding bug — **FIXED**
iproxy 2.x corrupts HTTP POST bodies, causing WDA to return JSON schema placeholders
instead of real data. `WDAClient` now auto-detects the device IP from `GET /status`
(`ios.ip`) and connects directly via Wi-Fi, bypassing iproxy for all POST requests.

### `maestro-runner` tap bug
`maestro-runner` internally calls WDA's `/wda/tap` vendor endpoint without properly establishing a session context. Screenshots work (GET endpoints don't need sessions), but all tap/click actions fail. As of v1.0.7, this is unfixed. Use `--runner wda` instead.

### WDA element locators
- `name` locator: works (`{"using":"name","value":"sendButton"}`)
- `-ios predicate string`: **not supported** in maestro-runner's WDA build
- `link text`: works
- Accessibility tree: `GET /session/{id}/source` returns XML

## Testing Tips

### LINE Bot E2E Testing (real device example)
```bash
npx tsx src/index.ts run jp.naver.line \
  --runner wda \
  --ios-device <UDID> \
  --team-id <TEAM_ID> \
  --driver-port 8100 \
  --language "zh-TW" \
  --max-steps 15 \
  --task "Open the chat with '圓桌智囊', type '你好', send it, wait 10 seconds for the bot reply, then confirm you received a response."
```

- LINE bundle ID: `jp.naver.line` (not `LINEInternal`)
- Set `--language` for CJK input accuracy
- Use `--max-steps 15` for simple send-and-verify flows (typically completes in 5 steps)
- The AI handles keyboard switching and send button tapping automatically
