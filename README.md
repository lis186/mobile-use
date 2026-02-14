# 📱 mobile-use

**AI-powered mobile task automation using natural language**

Introducing the Claude Computer Use for *Mobile Apps*. Execute complex tasks on mobile apps by simply describing what you want to do. mobile-use uses GPT-5.2 Pro vision to see your screen and Maestro to control the device.

**[Demo Video](https://drive.google.com/file/d/114EcATHluSHBV1mOlnM5uq7-Ob-TosY9/view)**

```bash
mobile-use com.apple.mobilenotes "Create a new note titled 'Meeting Notes' with bullet points for agenda items"
```

## How It Works

```
┌─────────────────┐     ┌────────────────┐     ┌─────────────────┐
│   mobile-use    │────▶│   GPT-5.2 Pro  │────▶│    Maestro      │
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
2. **Decide** - GPT-4o analyzes the image and decides the next action
3. **Execute** - Maestro performs the action on the device
4. **Repeat** - Until task is complete or max steps reached

##### Why use GPT 5.2?
GPT 5.2 has the highest recorded [ScreenSpot Pro](https://llm-stats.com/benchmarks/screenspot-pro) score of 86.3%. This is critical for analysis as we need to ensure we get the highest accurate coordinates for completing commands as well as critically understanding what's going on in a screen.

## Features

- **Vision-First AI** - Uses GPT-4o to understand screenshots and decide actions
- **Natural Language Tasks** - Describe what you want in plain English
- **Cross-Platform** - Works with iOS simulators and Android devices/emulators
- **Physical iOS Devices** - Supports real iPhones via `maestro-ios-device`
- **Multi-App Workflows** - Switch between apps to complete complex tasks
- **Smart Recovery** - Detects when stuck and tries alternative approaches
- **Fast Execution** - Optimized for speed with minimal overhead

## Requirements

- **Node.js** 18+
- **macOS** (for iOS) or **macOS/Linux/Windows** (for Android)
- **OpenAI API Key** with GPT-5.2 Pro access
- **Maestro CLI** (auto-installed via `mobile-use install-maestro`)

### For iOS Simulator
- Xcode with iOS Simulator (iOS 18.x or earlier — Maestro does not support iOS 26 simulators, see [Troubleshooting](#ios-26-xcode-26x-compatibility))

### For Android
- Android SDK with emulator or ADB-connected device

### For Physical iOS Devices
- macOS with Xcode
- Apple Developer account (free tier works)
- `maestro-ios-device` (install via `mobile-use install-ios-device`)

## Installation

```bash
# Install by Cloning
git clone https://github.com/31Carlton7/mobile-use

# Set your OpenAI API key
export OPENAI_API_KEY=your_api_key_here

# Install, Build, and link
npm i
npm run build
npm link

# Install Maestro CLI
mobile-use install-maestro

# Verify installation
mobile-use check
```

## Usage

### Basic Usage

```bash
# Run a task on a specific app
mobile-use <bundleId> "<task>"

# Example: Create a note
mobile-use com.apple.mobilenotes "Create a new note titled 'Hello World'"

# Example: Send a message
mobile-use com.apple.MobileSMS "Send 'Running late!' to John"
```

### Without Bundle ID (Foreground App)

Run tasks on whatever app is currently visible:

```bash
# Using --task flag
mobile-use --task "Tap the settings icon"

# Or just pass the task directly
mobile-use "Scroll down and tap on Privacy"
```

### With Custom Options

```bash
mobile-use com.example.app "Complete the checkout flow" \
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
mobile-use com.example.app "task" --device emulator-5554
```

### Physical iOS Device

**WDA runner (recommended)** - Direct WebDriverAgent communication, no bridge process needed:

```bash
# Get your device info
xcrun xctrace list devices                              # Get UDID
security find-identity -v -p codesigning | grep "Dev"   # Get Team ID

# Run with WDA runner (fastest)
mobile-use com.example.app "Create a note" \
  --runner wda \
  --ios-device DEVICE_UDID \
  --team-id YOUR_TEAM_ID
```

**Maestro runner** - Uses maestro-ios-device bridge:

```bash
# 1. Install the iOS device bridge
mobile-use install-ios-device

# 2. Start the bridge (keep running in separate terminal)
maestro-ios-device --team-id YOUR_TEAM_ID --device DEVICE_UDID

# 3. Run mobile-use
mobile-use com.example.app "Create a note" \
  --ios-device DEVICE_UDID \
  --team-id YOUR_TEAM_ID \
  --app-file /path/to/app.ipa
```

## Commands

| Command | Description |
|---------|-------------|
| `mobile-use <bundleId> <task>` | Run a task on the specified app |
| `mobile-use run <bundleId> <task>` | Same as above (explicit run command) |
| `mobile-use mcp` | Start MCP server for AI agent integration (stdio) |
| `mobile-use check` | Verify environment is properly configured |
| `mobile-use install-maestro` | Install Maestro CLI |
| `mobile-use install-ios-device` | Install maestro-ios-device (macOS only) |
| `mobile-use --help` | Show help information |

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `-t, --task <task>` | Task to execute (when bundleId is omitted) | - |
| `-m, --max-steps <n>` | Maximum steps before timeout | `100` |
| `--model <name>` | AI model to use | `gemini-2.5-flash` |
| `--language <code>` | Device UI language (`zh-TW`, `ja`, `ko`, etc.) | - |
| `--runner <type>` | Runner backend: `maestro`, `maestro-runner`, or `wda` | `maestro` |
| `--device <id>` | Android device ID | - |
| `--ios-device <udid>` | Physical iOS device UDID | - |
| `--team-id <id>` | Apple Developer Team ID | - |
| `--app-file <path>` | Path to .ipa file | - |
| `--driver-port <port>` | Driver host port | `8100` (wda) / `6001` (maestro) |

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
mobile-use com.apple.mobilenotes "Create a note" \
  --runner wda \
  --ios-device DEVICE_UDID \
  --team-id YOUR_TEAM_ID
```

On first run, Xcode will build WebDriverAgent (~1-2 min). Subsequent runs connect in seconds.

### Option B: Maestro Runner (iOS ≤ 18.x only)

Uses the `maestro-ios-device` XCTest bridge. **Does not work with iOS 26+ / Xcode 26.x** (see [Troubleshooting](#ios-26-xcode-26x-compatibility)).

```bash
# 1. Install the iOS device bridge
mobile-use install-ios-device

# 2. Start the bridge (keep running in separate terminal)
maestro-ios-device --team-id YOUR_TEAM_ID --device DEVICE_UDID

# 3. Run mobile-use
mobile-use com.example.app "Create a note" \
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
| clearState | ❌ | ⚠️ Reinstalls app |
| setLocation | ❌ | ⚠️ Limited |

## 🔍 Examples

### E-commerce Checkout
```bash
mobile-use com.amazon.Amazon "Search for 'wireless headphones', add the first result to cart, and proceed to checkout"
```

### Social Media
```bash
mobile-use com.instagram.instagram "Post the most recent photo from my camera roll with the caption 'Beautiful sunset!'"
```

### Productivity
```bash
mobile-use com.apple.mobilenotes "Create a new note titled 'Shopping List' with items: milk, eggs, bread, butter"
```

### Multi-App Workflow
```bash
mobile-use com.apple.mobilesafari "Copy the headline from cnn.com, then open Notes and paste it into a new note"
```

### Testing with Constraints
```bash
mobile-use com.myapp.test "Complete the signup flow" \
  --criteria "Welcome screen is displayed" \
  --criteria "User profile shows correct email" \
  --constraint "Use email: test@example.com" \
  --constraint "Skip optional fields"
```

## MCP Server (AI Agent Integration)

mobile-use can run as an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server, letting AI agents like Claude control your mobile device directly through tool calls.

### Quick Start

```bash
# Start MCP server with WDA runner (physical iOS device)
mobile-use mcp --runner wda --ios-device DEVICE_UDID --team-id YOUR_TEAM_ID

# Start MCP server with Maestro runner (simulator)
mobile-use mcp --runner maestro
```

### Claude Code Integration

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "mobile-use": {
      "command": "npx",
      "args": ["tsx", "/path/to/mobile-use/src/index.ts", "mcp",
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
| `--runner <type>` | Runner backend: `maestro` or `wda` | `maestro` |
| `--ios-device <udid>` | Physical iOS device UDID | - |
| `--team-id <id>` | Apple Developer Team ID | - |
| `--driver-port <port>` | Driver host port | `8100` (wda) / `6001` (maestro) |

### Architecture

The MCP server uses **lazy device connection** (connects on first tool call, not at startup), **persistent sessions** (reuses the WDA/Maestro session across all tool calls), and **retry-on-stale** (auto-reconnects if a session expires). All device logs go to stderr, keeping stdout clean for JSON-RPC.

## Performance Optimizations

mobile-use includes several optimizations to reduce cost, improve speed, and increase reliability:

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
mobile-use com.apple.Preferences "Go to General" --language zh-TW
```

Supported codes: `zh-TW`, `zh-CN`, `ja`, `ko`, `en`, `es`, `fr`, `de`, `pt`, `th`, `vi`, `ar`. Any other value is passed through as-is.

## Troubleshooting

### "Maestro not installed"
```bash
mobile-use install-maestro
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

**For physical devices → use WDA runner:**

The WDA runner uses Apple's own WebDriverAgent framework, which has forward compatibility with new iOS versions. This is the recommended solution:

```bash
mobile-use com.example.app "Your task" \
  --runner wda \
  --ios-device DEVICE_UDID \
  --team-id YOUR_TEAM_ID
```

**For simulators → use an older iOS runtime:**

Maestro does **not** support iOS 26 simulators, even when built from source (tested: `main` branch hangs indefinitely on `maestro test`). The workaround is to install an older iOS simulator runtime:

```bash
# Install iOS 18.x runtime via Xcode
# Xcode → Settings → Platforms → + → iOS 18.x

# Create a simulator with the older runtime
xcrun simctl create "iPhone 16 Pro" "iPhone 16 Pro" iOS-18-4

# Boot and use it
xcrun simctl boot "iPhone 16 Pro"
mobile-use com.example.app "Your task" --runner maestro
```

Alternatively, if you have a physical iOS device (even running iOS 26.x), use the WDA runner — it works regardless of iOS version.

**Why WDA works but XCTest doesn't:**

The root cause is that Maestro relies on XCTest, and Apple changed XCTest behavior in Xcode 26.x. The XCTest driver installs on the device/simulator but immediately exits without listening on port 7001.

WDA (WebDriverAgent) is a separate Apple framework that communicates over HTTP and is not affected by the XCTest changes.

| Approach | Backend | iOS 26 Status | Performance |
|----------|---------|---------------|-------------|
| `--runner maestro` | Maestro CLI + XCTest | ❌ Hangs on both simulator and device | Baseline |
| `maestro-ios-device` | XCTest bridge | ❌ Same XCTest issue | ~1x |
| `maestro-runner` | WDA (via CLI) | ✅ Physical device only, restarts WDA per action | ~10-18s/action |
| `--runner wda` | WDA (direct HTTP) | ✅ Physical device, persistent session | **~0.2-1s/action** |
| Older iOS simulator | Maestro + XCTest | ✅ Use iOS 18.x runtime as workaround | Baseline |

## 📄 License

MIT

## Acknowledgments

- [Maestro](https://maestro.mobile.dev) - Mobile UI automation framework
- [OpenAI GPT-5.2 Pro](https://openai.com) - Vision-language model
- [maestro-ios-device](https://github.com/devicelab-dev/maestro-ios-device) - Physical iOS device support

*In God we trust🙏🏿*
