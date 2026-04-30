# 📱 phone-use

**AI-powered mobile task automation using natural language**

Execute complex tasks on mobile apps by simply describing what you want to do. phone-use uses Vision AI to see your screen and automation backends (Maestro/WDA/XCTest) to control the device.

phone-use ships two top-level commands. Pick the one that matches your goal:

| If you want to… | Use | Jump to |
|---|---|---|
| automate a specific task ("send a message", "fill a form") | `phone-use run` | [Quickstart](#quickstart-run-mode) |
| get an autonomous UX audit of an iOS app — issues + annotated screenshots, no task to write | `phone-use audit` | [Quickstart](#quickstart-audit-mode) |

### Quickstart — `run` mode

```bash
phone-use com.apple.mobilenotes "Create a new note titled 'Meeting Notes' with bullet points for agenda items"
```

### Quickstart — `audit` mode

```bash
# iOS 26 simulator (default — uses the booted simulator)
phone-use audit com.apple.Preferences --runner xctest

# Real iPhone (WDA auto-builds + auto-launches; first run ~2-3 min)
phone-use audit com.apple.Preferences \
  --runner wda --ios-device <UDID> --team-id <TEAM_ID>

# Focus the audit on a specific feature area
phone-use audit com.apple.Maps --scope "search and route planning"
```

Outputs land in `audit-output/<timestamp>-<bundleId>/` — `report.md`, `annotated/step-NN.jpg`, `steps.jsonl`, `issues.jsonl`. Full reference: [Autonomous UX Audit](#autonomous-ux-audit-phase-1).

## How It Works

```
┌─────────────────┐     ┌────────────────┐     ┌─────────────────┐
│   phone-use    │────▶│   Vision AI    │────▶│    Maestro      │
│   (CLI/Node)    │     │  (Vision AI)   │     │   (Automation)  │
└─────────────────┘     └────────────────┘     └─────────────────┘
        │                      │                      │
        │                      │                      ▼
        │                      │              ┌───────────────┐
        │                      │              │   Device      │
        │                      │              │ (iOS/Android) │
        │                      │              └───────────────┘
        │                      │                      │
        ▼                      ▼                      ▼
   1. Capture          2. Analyze &           3. Execute
   Screenshot          Decide Action          Action
```

**Loop:**
1. **Observe** - Take a screenshot of the current screen
2. **Decide** - Vision AI analyzes the image and decides the next action
3. **Execute** - Maestro performs the action on the device
4. **Repeat** - Until task is complete or max steps reached

##### Why Vision AI?
phone-use supports multiple vision-capable models (Gemini, GPT, etc.) that can accurately identify UI elements and coordinates from screenshots.

## Features

- **Vision-First AI** - Uses Vision AI to understand screenshots and decide actions
- **Natural Language Tasks** - Describe what you want in plain English
- **Cross-Platform** - Works with iOS simulators and Android devices/emulators
- **Physical iOS Devices** - Supports real iPhones via the WDA runner (`--runner wda`); auto-builds and launches WebDriverAgent
- **Multi-App Workflows** - Switch between apps to complete complex tasks
- **Smart Recovery** - Detects when stuck and tries alternative approaches
- **Fast Execution** - Optimized for speed with minimal overhead

## Requirements

- **Node.js** 18+
- **macOS** (for iOS) or **macOS/Linux/Windows** (for Android)
- **AI API Key** (Google Gemini recommended, OpenAI also supported)
- **Maestro CLI** (auto-installed via `phone-use install-maestro`)

### For iOS Simulator
- Xcode with iOS Simulator
- For iOS 26+ simulators, use `--runner xctest` (see [XCTest Runner](#xctest-runner-ios-26-simulators))
- For iOS 18.x and earlier, `--runner maestro` works out of the box

### For Android
- Android SDK with emulator or ADB-connected device

### For Physical iOS Devices
- macOS with Xcode
- Apple Developer account (free tier works)
- **Recommended**: use `--runner wda` — `WDAClient` auto-builds and spawns WebDriverAgent + iproxy, no extra install required (first launch ~2-3 min while Xcode builds WDA, subsequent launches are instant)
- Optional fallback: `maestro-ios-device` (install via `phone-use install-ios-device`) for `--runner maestro` on iOS ≤18.x. Does not work on iOS 26+

## Installation

phone-use is not published to npm. Install by cloning and linking:

```bash
# 1. Clone
git clone https://github.com/lis186/phone-use
cd phone-use

# 2. Configure API keys — copy .env.example to .env and fill in at least one.
# For `phone-use audit` the default is Gemini (GOOGLE_GENERATIVE_AI_API_KEY).
# `phone-use run` also accepts OPENAI_API_KEY when you pass a `gpt-*`/`o*` model.
cp .env.example .env
$EDITOR .env

# 3. Install, build, and link onto your $PATH
npm i
npm run build
npm link

# 4. (Optional) Install Maestro CLI — only needed for `--runner maestro`
#    (iOS Simulator ≤18.x). Skip if you only use --runner xctest (iOS 26+
#    simulator) or --runner wda (real device).
phone-use install-maestro

# 5. Verify
phone-use check
```

To pull updates later: `cd phone-use && git pull && npm i && npm run build` — the existing `npm link` keeps pointing at the rebuilt `dist/`.

## Usage

### Basic Usage

```bash
# Run a task on a specific app
phone-use <bundleId> "<task>"

# Example: Create a note
phone-use com.apple.mobilenotes "Create a new note titled 'Hello World'"

# Example: Send a message
phone-use com.apple.MobileSMS "Send 'Running late!' to John"
```

### Without Bundle ID (Foreground App)

Run tasks on whatever app is currently visible:

```bash
# Using --task flag
phone-use --task "Tap the settings icon"

# Or just pass the task directly
phone-use "Scroll down and tap on Privacy"
```

### With Custom Options

```bash
phone-use com.example.app "Complete the checkout flow" \
  --max-steps 50 \
  --model gpt-4o \
  --criteria "Order confirmation is visible" \
  --constraint "Don't use saved payment methods"
```

### Android Device Selection

```bash
# List connected devices
adb devices

# Run on specific device/emulator
phone-use com.example.app "task" --device emulator-5554
```

### Physical iOS Device

**WDA runner (recommended)** - Direct WebDriverAgent communication, no bridge process needed:

```bash
# Get your device info
xcrun xctrace list devices                              # Get UDID
security find-identity -v -p codesigning | grep "Dev"   # Get Team ID

# Run with WDA runner (fastest)
phone-use com.example.app "Create a note" \
  --runner wda \
  --ios-device DEVICE_UDID \
  --team-id YOUR_TEAM_ID
```

**Maestro runner** - Uses maestro-ios-device bridge:

```bash
# 1. Install the iOS device bridge
phone-use install-ios-device

# 2. Start the bridge (keep running in separate terminal)
maestro-ios-device --team-id YOUR_TEAM_ID --device DEVICE_UDID

# 3. Run phone-use
phone-use com.example.app "Create a note" \
  --ios-device DEVICE_UDID \
  --team-id YOUR_TEAM_ID \
  --app-file /path/to/app.ipa
```

## Commands

| Command | Description |
|---------|-------------|
| `phone-use <bundleId> <task>` | Run a task on the specified app |
| `phone-use run <bundleId> <task>` | Same as above (explicit run command) |
| `phone-use mcp` | Start MCP server for AI agent integration (stdio) |
| `phone-use check` | Verify environment is properly configured |
| `phone-use install-maestro` | Install Maestro CLI |
| `phone-use install-ios-device` | Install maestro-ios-device (macOS only) |
| `phone-use --help` | Show help information |

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `-t, --task <task>` | Task to execute (when bundleId is omitted) | - |
| `-m, --max-steps <n>` | Maximum steps before timeout | `100` |
| `--model <name>` | AI model to use | `gemini-2.5-flash` |
| `--language <code>` | Device UI language (`zh-TW`, `ja`, `ko`, etc.) | - |
| `--runner <type>` | Runner backend: `maestro` (sim ≤18.x), `wda` (real device), `xctest` (sim 26+), or `maestro-runner` (⚠️ broken — tap fails, see CLAUDE.md) | `maestro` |
| `--device <id>` | Device ID (Android emulator or iOS simulator UDID for xctest) | - |
| `--ios-device <udid>` | Physical iOS device UDID | - |
| `--team-id <id>` | Apple Developer Team ID | - |
| `--app-file <path>` | Path to .ipa file | - |
| `--xctestrun-path <path>` | Path to .xctestrun file (for xctest runner) | - |
| `--driver-port <port>` | Driver host port | `22087` (xctest) / `8100` (wda) / `6001` (maestro) |

## Available Actions

The AI can perform these actions on your device:

| Action | Description | Example |
|--------|-------------|---------|
| `tap` | Tap at coordinates (% of screen) | `tap(50, 50)` |
| `tapText` | Tap element with visible text | `tapText("Submit")` |
| `doubleTap` | Double-tap at coordinates | `doubleTap(50, 50)` |
| `longPress` | Long press at coordinates or text | `longPress(50, 50)` |
| `inputText` | Type text into focused field | `inputText("Hello")` |
| `eraseText` | Delete characters | `eraseText(10)` |
| `scroll` | Scroll down | `scroll()` |
| `swipe` | Swipe gesture | `swipe(50,80 → 50,20)` |
| `back` | Navigate back | `back()` |
| `hideKeyboard` | Dismiss keyboard | `hideKeyboard()` |
| `openLink` | Open a URL/deep link | `openLink("app://...")` |
| `pressKey` | Press a key (enter, etc.) | `pressKey("enter")` |
| `wait` | Wait for animations | `wait()` |
| `launchApp` | Switch to another app | `launchApp("com.other.app")` |
| `stopApp` | Close an app | `stopApp("com.other.app")` |

## Autonomous UX Audit (Phase 1)

`phone-use audit` explores an iOS 26 simulator app and writes a Markdown
report grounded in Don Norman's principles, Nielsen's heuristics, and
Apple's Human Interface Guidelines. Every step produces an annotated
screenshot so the final report is self-explanatory.

```bash
# Minimal invocation — audits the Settings app for 25 steps on the
# currently-booted iOS 26 simulator.
phone-use audit com.apple.Preferences \
  --runner xctest \
  --device <simulator-udid> \
  --max-steps 25 \
  --model gemini-2.5-flash

# Attach to an already-running app (skip the launch step — useful for
# pre-authenticated state).
phone-use audit jp.naver.line --runner xctest --skip-launch

# Focus the audit on a specific feature area instead of wandering.
phone-use audit com.apple.Maps \
  --runner xctest \
  --scope "direction search flow" \
  --max-steps 20
```

Output lands under the current working directory by default
(`./audit-output/<timestamp>-<bundleId>/`). Paths passed to
`--output-dir` are also resolved relative to the CWD — so if you
`cd ~/projects/audits` first, the report lands there regardless of
where `phone-use` is installed. Each run directory contains:

- `report.md` — the full audit report with issues grouped by severity
- `annotated/step-NN.jpg` — every step's screenshot with a red marker
  and a "why I tapped here" card embedded in the image
- `steps.jsonl` / `issues.jsonl` — append-only structured logs
- `timings.json` — per-segment P50/P95/avg latency and token cost

Screenshots may contain personal data (account names, chat content,
location). `audit-output/` is gitignored by default — share individual
reports manually on a per-run basis rather than checking them in.

See `docs/audit-errors.md` for every `AuditError` code, the most common
causes, and what to try first when a run fails.

**Supported targets**: iOS 26 Simulator via `--runner xctest` (default for the audit command), or a physical iPhone via `--runner wda --ios-device <UDID> --team-id <TEAM_ID>`. Both have been validated end-to-end on real apps.

## Physical iOS Device Setup

### Prerequisites
- macOS with Xcode installed
- Apple Developer account (free tier works for personal devices)
- iOS device connected via USB

### Device Preparation

1. **Connect and configure device:**
   - Connect iPhone via USB cable
   - Trust the computer when prompted
   - Enable Developer Mode:
     - Settings → Privacy & Security → Developer Mode → Enable
   - Enable UI Automation:
     - Settings → Developer → Enable UI Automation

2. **Get device information:**
   ```bash
   # Find your device UDID
   xcrun xctrace list devices

   # Find your Team ID
   security find-identity -v -p codesigning | grep "Developer"
   ```

### Option A: WDA Runner (Recommended)

The WDA (WebDriverAgent) runner communicates directly with Apple's WebDriverAgent over HTTP. No bridge process needed, ~24-143x faster per action than alternatives, and works with **iOS 12.0+ including iOS 26.x**.

```bash
# One command — WDA is built and launched automatically
phone-use com.apple.mobilenotes "Create a note" \
  --runner wda \
  --ios-device DEVICE_UDID \
  --team-id YOUR_TEAM_ID
```

On first run, Xcode will build WebDriverAgent (~1-2 min). Subsequent runs connect in seconds.

### Option B: Maestro Runner (iOS ≤ 18.x only)

Uses the `maestro-ios-device` XCTest bridge. **Does not work with iOS 26+ / Xcode 26.x** (see [Troubleshooting](#ios-26-xcode-26x-compatibility)).

```bash
# 1. Install the iOS device bridge
phone-use install-ios-device

# 2. Start the bridge (keep running in separate terminal)
maestro-ios-device --team-id YOUR_TEAM_ID --device DEVICE_UDID

# 3. Run phone-use
phone-use com.example.app "Create a note" \
  --ios-device DEVICE_UDID \
  --team-id YOUR_TEAM_ID
```

### Limitations on Physical iOS
| Feature | WDA Runner | Maestro Runner |
|---------|-----------|----------------|
| Tap, swipe, input | ✅ | ✅ |
| Screenshots | ✅ | ✅ |
| App launch/stop | ✅ | ✅ |
| Accessibility tree | ✅ | ❌ |
| iOS 26+ support | ✅ | ❌ |

## 🔍 Examples

### E-commerce Checkout
```bash
phone-use com.amazon.Amazon "Search for 'wireless headphones', add the first result to cart, and proceed to checkout"
```

### Social Media
```bash
phone-use com.instagram.instagram "Post the most recent photo from my camera roll with the caption 'Beautiful sunset!'"
```

### Productivity
```bash
phone-use com.apple.mobilenotes "Create a new note titled 'Shopping List' with items: milk, eggs, bread, butter"
```

### Multi-App Workflow
```bash
phone-use com.apple.mobilesafari "Copy the headline from cnn.com, then open Notes and paste it into a new note"
```

### Testing with Constraints
```bash
phone-use com.myapp.test "Complete the signup flow" \
  --criteria "Welcome screen is displayed" \
  --criteria "User profile shows correct email" \
  --constraint "Use email: test@example.com" \
  --constraint "Skip optional fields"
```

## MCP Server (AI Agent Integration)

phone-use can run as an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server, letting AI agents like Claude control your mobile device directly through tool calls.

### Quick Start

```bash
# Start MCP server with WDA runner (physical iOS device)
phone-use mcp --runner wda --ios-device DEVICE_UDID --team-id YOUR_TEAM_ID

# Start MCP server with XCTest runner (iOS simulator, including iOS 26+)
phone-use mcp --runner xctest --device SIMULATOR_UDID

# Start MCP server with Maestro runner (simulator, iOS 18.x or earlier)
phone-use mcp --runner maestro
```

### Claude Code Integration

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "phone-use": {
      "command": "npx",
      "args": ["tsx", "/path/to/phone-use/src/index.ts", "mcp",
               "--runner", "wda",
               "--ios-device", "DEVICE_UDID",
               "--team-id", "YOUR_TEAM_ID"]
    }
  }
}
```

Once configured, Claude can use 16 tools to interact with your device:

| Category | Tools |
|----------|-------|
| Observation | `screenshot`, `accessibility_tree` |
| Actions | `tap`, `tap_text`, `input_text`, `erase_text`, `scroll`, `swipe`, `back`, `hide_keyboard`, `open_link`, `press_key` |
| App Management | `launch_app`, `stop_app`, `device_info` |
| Automation | `run_task` (delegates to the autonomous AI agent loop) |

### MCP Options

| Option | Description | Default |
|--------|-------------|---------|
| `--runner <type>` | Runner backend: `maestro`, `wda`, or `xctest` | `maestro` |
| `--device <id>` | Simulator UDID (for xctest runner) | - |
| `--ios-device <udid>` | Physical iOS device UDID | - |
| `--team-id <id>` | Apple Developer Team ID | - |
| `--xctestrun-path <path>` | Path to .xctestrun file (for xctest runner) | - |
| `--driver-port <port>` | Driver host port | `22087` (xctest) / `8100` (wda) / `6001` (maestro) |

### Architecture

The MCP server uses **lazy device connection** (connects on first tool call, not at startup), **persistent sessions** (reuses the WDA/Maestro session across all tool calls), and **retry-on-stale** (auto-reconnects if a session expires). All device logs go to stderr, keeping stdout clean for JSON-RPC.

## Performance Optimizations

phone-use includes several optimizations to reduce cost, improve speed, and increase reliability:

### Screenshot Compression

Before sending screenshots to the AI model, images are resized to 1/2 resolution and converted from PNG to JPEG (quality 80). This reduces vision token costs by **89-98%** per image while maintaining sufficient quality for UI element identification.

- Original: 1290x2796 PNG (~300-1000KB)
- Optimized: 645x1398 JPEG (~15-85KB)
- Implementation: `sharp` library in `agent.ts:optimizeImage()`

### History Image Stripping

The conversation history sent to the AI model can accumulate many screenshots. To avoid sending redundant old images, only the **last 2 screenshots** are kept as images — older messages are converted to text-only summaries (`[screenshot omitted]`). This removes ~6 redundant screenshots per API call, reducing vision tokens by an additional **~60%** while preserving full action context.

### Adaptive Post-Action Delay

Instead of a fixed 1500ms delay between steps, delays are tuned per action type:

| Action | Delay |
|--------|-------|
| `launchApp`, `stopApp` | 3000ms |
| `inputText`, `scroll`, `swipe` | 800ms |
| `tap`, `tapText`, others | 500ms |
| `wait` | 0ms (self-managed) |

This reduces per-step overhead by **30-60%** for tap-heavy workflows.

### Device Language Hint

Use the `--language` flag to tell the AI model what language the device UI is in. This prevents the model from trying English text (e.g., "General") when the device shows localized text (e.g., "一般").

```bash
phone-use com.apple.Preferences "Go to General" --language zh-TW
```

Supported codes: `zh-TW`, `zh-CN`, `ja`, `ko`, `en`, `es`, `fr`, `de`, `pt`, `th`, `vi`, `ar`. Any other value is passed through as-is.

## XCTest Runner (iOS 26+ Simulators)

The `xctest` runner connects directly to the Maestro XCTest driver's REST API on port 22087, bypassing the Maestro CLI. This is the recommended runner for **iOS simulators on macOS Tahoe / Xcode 26.x**, where the Maestro CLI hangs.

### Usage

```bash
# Basic usage — auto-builds and starts the XCTest driver
phone-use com.apple.mobilesafari "Search for hello" \
  --runner xctest \
  --device SIMULATOR_UDID

# With a custom xctestrun file
phone-use com.apple.mobilesafari "Search for hello" \
  --runner xctest \
  --device SIMULATOR_UDID \
  --xctestrun-path /path/to/maestro-driver-ios.xctestrun
```

### How It Works

1. Checks if the XCTest driver is already running on port 22087
2. If not, auto-discovers or builds the `.xctestrun` file from `~/.maestro/maestro-ios-xctest-runner/`
3. Starts `xcodebuild test-without-building` with `-only-testing testHttpServer`
4. Waits for the HTTP server to become ready
5. All device actions (tap, screenshot, input, etc.) go through the REST API

### Prerequisites

- Maestro CLI installed (`phone-use install-maestro`) — needed for the XCTest driver source
- Xcode with a booted iOS simulator
- The driver is auto-built on first run (~1-2 min). Subsequent runs reuse the built artifacts.

## Troubleshooting

### "Maestro not installed"
```bash
phone-use install-maestro
# Then add to PATH:
export PATH="$PATH:$HOME/.maestro/bin"
```

### "API key not found"
```bash
export OPENAI_API_KEY=your_key_here
# Add to ~/.zshrc or ~/.bashrc for persistence
```

### AI keeps tapping wrong coordinates
The AI estimates tap positions as percentages. If it's consistently wrong:
- The AI will auto-detect stuck patterns and try alternatives
- Use `tapText` instead when there's visible text
- Increase `--max-steps` to give it more attempts

### Physical iOS device not found
```bash
# Check device is connected
xcrun xctrace list devices

# Ensure Developer Mode is enabled
# Settings → Privacy & Security → Developer Mode

# Re-trust the computer
# Unplug and replug, tap "Trust" when prompted
```

### maestro-ios-device bridge crashes
```bash
# Check iOS version compatibility (16.x - 18.x)
# Ensure Xcode is up to date
# Check device logs: Window → Devices and Simulators → View Device Logs
```

### iOS 26+ / Xcode 26.x Compatibility

Maestro's XCTest driver is **incompatible with Xcode 26.x**. Symptoms:

- `spawnSync /bin/sh ETIMEDOUT` — Maestro times out connecting to device
- `iOS driver not ready in time` — XCTest driver fails to start
- `Failed to connect to /127.0.0.1:7001` — XCTest runner exits immediately
- `maestro-ios-device` crashes on iOS 26.x devices

Related issues: [#2894](https://github.com/mobile-dev-inc/maestro/issues/2894), [#2932](https://github.com/mobile-dev-inc/maestro/issues/2932)

**For simulators → use XCTest runner (recommended):**

The `xctest` runner connects directly to the Maestro XCTest driver's REST API, bypassing the Maestro CLI entirely. This works on iOS 26 simulators where `maestro test` hangs:

```bash
# Get your simulator UDID
xcrun simctl list devices booted

# Run with xctest runner
phone-use com.example.app "Your task" \
  --runner xctest \
  --device SIMULATOR_UDID
```

The XCTest driver is auto-built on first run from `~/.maestro/maestro-ios-xctest-runner/`. Subsequent runs connect in seconds if the driver is already running.

**For physical devices → use WDA runner:**

The WDA runner uses Apple's own WebDriverAgent framework, which has forward compatibility with new iOS versions:

```bash
phone-use com.example.app "Your task" \
  --runner wda \
  --ios-device DEVICE_UDID \
  --team-id YOUR_TEAM_ID
```

**Fallback: use an older iOS simulator runtime:**

If you prefer the Maestro runner, you can install an older iOS runtime:

```bash
# Install iOS 18.x runtime via Xcode
# Xcode → Settings → Platforms → + → iOS 18.x

# Create a simulator with the older runtime
xcrun simctl create "iPhone 16 Pro" "iPhone 16 Pro" iOS-18-4

# Boot and use it
xcrun simctl boot "iPhone 16 Pro"
phone-use com.example.app "Your task" --runner maestro
```

**Why Maestro CLI doesn't work on iOS 26:**

The root cause is that Maestro CLI relies on its own device enumeration and XCTest lifecycle management, which broke with Xcode 26.x. The XCTest driver itself works fine — only the Maestro CLI wrapper is broken. The `xctest` runner bypasses this by talking to the XCTest driver's HTTP API directly.

| Approach | Backend | iOS 26 Status | Performance |
|----------|---------|---------------|-------------|
| `--runner xctest` | XCTest driver (direct HTTP) | ✅ Simulator, persistent session | **~0.2-1s/action** |
| `--runner wda` | WDA (direct HTTP) | ✅ Physical device, persistent session | **~0.2-1s/action** |
| `--runner maestro` | Maestro CLI + XCTest | ❌ Hangs on both simulator and device | Baseline |
| `maestro-ios-device` | XCTest bridge | ❌ Same Maestro CLI issue | ~1x |
| `maestro-runner` | WDA (via CLI) | ✅ Physical device only, restarts WDA per action | ~10-18s/action |
| Older iOS simulator | Maestro + XCTest | ✅ Use iOS 18.x runtime as workaround | Baseline |

## 📄 License

MIT

## Acknowledgments

- [Maestro](https://maestro.mobile.dev) - Mobile UI automation framework
- [Google Gemini](https://aistudio.google.com) / [OpenAI](https://openai.com) - Vision-language models
- [maestro-ios-device](https://github.com/devicelab-dev/maestro-ios-device) - Physical iOS device support

Originally forked from [31Carlton7/mobile-use](https://github.com/31Carlton7/mobile-use).
