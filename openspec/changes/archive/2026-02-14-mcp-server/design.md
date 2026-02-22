## Context

phone-use is a Node.js/TypeScript CLI tool that automates mobile apps via natural language. It currently has two device backends (`WDAClient` for real iOS devices, `MaestroClient` for simulators via Maestro CLI) tightly coupled with a CLI frontend (spinners, formatted output) and an autonomous AI agent loop.

The project uses ESM modules, Commander for CLI, and builds with tsup. It already has `zod` (for schema validation) and supports both Google and OpenAI AI providers.

Key constraint: WDA sessions are stateful and expensive to start (~15s). The MCP server must keep sessions alive across tool calls. The current `WDAClient.start()` already supports auto-connecting to externally-managed WDA instances.

## Goals / Non-Goals

**Goals:**

- Expose mobile automation as MCP tools so Claude Code, Cursor, and other MCP clients can directly observe and control devices
- Return screenshots as native MCP image content (not base64 strings the AI must decode)
- Maintain persistent device sessions across tool calls (connect once, use many times)
- Extract a `MobileDevice` interface so backends are swappable (WDA, Maestro, future ADB/simctl)
- Keep the existing `run` CLI command working unchanged
- Single npm package: `npx phone-use run ...` and `npx phone-use mcp ...`

**Non-Goals:**

- Android (ADB) backend — future work, but the interface must accommodate it
- iOS Simulator (simctl) backend — future work, same
- Remote device farm support (BrowserStack, etc.) — future
- Web UI or dashboard
- Multi-device simultaneous control

## Decisions

### 1. MCP transport: stdio only

**Decision**: Use stdio transport (stdin/stdout JSON-RPC), not HTTP/SSE.

**Rationale**: All major MCP clients (Claude Code, Cursor, Windsurf, Cline) launch MCP servers as child processes via stdio. HTTP transport adds complexity (port management, CORS, auth) with no adoption benefit. Stdio is the standard.

**Alternative considered**: HTTP/SSE for remote device access. Deferred — can add later as a second transport without changing tool definitions.

### 2. Directory structure: `src/core/` + `src/mcp/` + `src/cli/`

**Decision**: Three-layer architecture.

```
src/
├── core/                    # Pure library — no UI, no transport
│   ├── device.ts            # MobileDevice interface
│   ├── wda-device.ts        # WDAClient implementing MobileDevice
│   ├── maestro-device.ts    # MaestroClient implementing MobileDevice
│   └── tree-parser.ts       # Accessibility tree → text (extracted from agent.ts)
│
├── mcp/                     # MCP server layer
│   └── server.ts            # Tool definitions, session lifecycle
│
├── cli/                     # CLI layer (existing, refactored)
│   └── index.ts             # Commander commands: run, mcp, check, etc.
│
├── agent.ts                 # Autonomous AI loop (unchanged, uses core/)
└── executor.ts              # Task orchestrator (unchanged, uses core/)
```

**Rationale**: Clean separation of concerns. Core has zero dependencies on transport or UI. MCP and CLI are thin layers over core. Agent/executor stay as-is but import from `core/` instead of directly from `wda.ts`/`maestro.ts`.

**Alternative considered**: Keep flat structure, just add `mcp-server.ts`. Rejected — the coupling would make Android/simctl backends painful to add.

### 3. `MobileDevice` interface design

**Decision**: Minimal async interface matching existing method signatures.

```typescript
interface MobileDevice {
  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Observation
  screenshot(): Promise<Buffer>;
  accessibilityTree(): Promise<string>;  // raw XML/JSON
  screenSize(): { width: number; height: number };

  // Actions (coordinates as 0-100 percentages)
  tap(x: number, y: number): Promise<void>;
  tapText(text: string): Promise<void>;
  doubleTap(x: number, y: number): Promise<void>;
  longPress(x: number, y: number): Promise<void>;
  inputText(text: string): Promise<void>;
  eraseText(chars?: number): Promise<void>;
  scroll(): Promise<void>;
  swipe(startX: number, startY: number, endX: number, endY: number): Promise<void>;
  back(): Promise<void>;
  hideKeyboard(): Promise<void>;
  openLink(url: string): Promise<void>;
  pressKey(key: string): Promise<void>;

  // App management
  launchApp(bundleId: string): Promise<void>;
  stopApp(bundleId: string): Promise<void>;
}
```

**Rationale**: Maps 1:1 to existing `WDAClient` and `MaestroClient` public methods. `connect()`/`disconnect()` replace `start()`/`stop()`. Screenshot returns `Buffer` (not base64) — callers choose encoding. Coordinates stay as percentages (0-100) — the universal coordinate system across platforms.

**Alternative considered**: Separate `Observation` and `Action` interfaces. Over-engineering for current scope — a single interface is simpler and both backends implement everything.

### 4. MCP tool granularity: one tool per action

**Decision**: Each mobile action is a separate MCP tool (not one mega-tool with an `action` parameter).

```
Tools: screenshot, accessibility_tree, tap, tap_text, input_text,
       scroll, swipe, back, hide_keyboard, open_link, press_key,
       launch_app, stop_app, device_info, run_task
```

**Rationale**: MCP tool schemas are self-describing. Separate tools give the AI model clear parameter schemas for each action. A single `execute_action({action: "tap", params: {x, y}})` tool loses type safety and makes the AI guess parameter shapes.

**Alternative considered**: Grouped tools (one for observation, one for actions). Rejected — forces the AI to construct complex nested parameters.

### 5. Session lifecycle: connect-on-first-use, lazy initialization

**Decision**: The MCP server does NOT connect to a device at startup. Instead, it connects on the first tool call that requires a device, and keeps the session alive for subsequent calls.

**Rationale**: MCP servers start when the client launches (e.g., Claude Code startup). The device may not be plugged in yet. Lazy connection avoids startup failures. The `device_info` tool can also serve as an explicit "connect now" trigger.

**Alternative considered**: Connect at startup via config. Fragile — device must be ready before Claude Code starts.

### 6. Tree parser extraction

**Decision**: Move `parseAccessibilityTree()`, `parseWDATree()`, `parseMaestroTree()` from `TaskAgent` class into standalone `src/core/tree-parser.ts` functions.

**Rationale**: The tree parser is used by both the MCP server (to return parsed tree text) and the autonomous agent. It has no dependency on the AI SDK or conversation history — it's pure data transformation.

### 7. `run_task` as an MCP tool

**Decision**: Expose the autonomous AI loop as a single `run_task` MCP tool for delegated automation.

```
run_task({ task: "Open Settings and go to About", bundleId: "com.apple.Preferences" })
→ returns: { success: true, steps: 2, reason: "..." }
```

**Rationale**: Some tasks are better delegated ("just do this") than micro-managed step-by-step. The outer AI can choose: use individual tools for precision, or `run_task` for convenience. This preserves the current value proposition.

## Risks / Trade-offs

**[Risk] Screenshot size in MCP responses** → MCP messages have practical size limits. Apply the existing image optimization (resize + JPEG compression) before returning screenshots. The `sharp` dependency already handles this.

**[Risk] Accessibility tree too large** → Apply the existing 2000-char cap from the tree parser. For MCP, also offer a `raw` option that returns the full tree for advanced use cases.

**[Risk] WDA session timeout** → WDA sessions can expire if idle too long. Add a health check before each tool call; reconnect transparently if the session is stale.

**[Risk] Breaking existing CLI users** → The `run` command must work exactly as before. Refactoring to `core/` is internal — the CLI imports change but behavior doesn't. Verify with existing test commands.

**[Trade-off] No streaming for screenshots** → MCP tool responses are atomic (not streamed). A screenshot is ~50-80KB after optimization — small enough for a single response. If video/continuous observation is needed later, MCP resources or subscriptions could be explored.

**[Trade-off] Single device per server instance** → Supporting multiple devices simultaneously adds session routing complexity. Defer to later. Users can run multiple MCP server instances for multiple devices.
