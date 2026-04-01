# Mobile Use — Development Guide

AI-powered mobile task automation. Natural language → screenshot → AI decision → device action loop.

## Project Structure

- `src/index.ts` — CLI entry point (commander)
- `src/executor.ts` — Task execution loop (observe → decide → execute → repeat)
- `src/agent.ts` — AI agent (vision model integration)
- `src/wda.ts` — WDAClient for physical iOS devices
- `src/maestro.ts` — MaestroClient for simulators
- `src/xctest.ts` — XCTest runner for iOS 26+ simulators
- `src/types.ts` — Shared types (`RunnerType`, `TaskConfig`, etc.)

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
