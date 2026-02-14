## 1. Project Setup

- [x] 1.1 Create directory structure: `src/core/`, `src/mcp/`, `src/cli/`
- [x] 1.2 Add `@modelcontextprotocol/sdk` dependency to package.json
- [x] 1.3 Update tsup build config to include new entry points if needed

## 2. Core: MobileDevice Interface

- [x] 2.1 Create `src/core/device.ts` with the `MobileDevice` interface (lifecycle, observation, actions, app management methods)
- [x] 2.2 Export all core modules from `src/core/index.ts` barrel file

## 3. Core: Tree Parser Extraction

- [x] 3.1 Create `src/core/tree-parser.ts` — move `parseAccessibilityTree()`, `parseWDATree()`, `parseMaestroTree()` from `src/agent.ts`
- [x] 3.2 Update `src/agent.ts` to import tree parser from `src/core/tree-parser.ts` instead of using local methods
- [x] 3.3 Build gate: `tsc --noEmit` passes with zero errors
- [x] 3.4 CLI regression: WDA runner — app launch, screenshot, accessibility tree all work (Gemini rate limit prevented full task completion, not a regression)

## 4. Core: WDA Backend

- [x] 4.1 Create `src/core/wda-device.ts` — refactor `WDAClient` to implement `MobileDevice` (`start()` → `connect()`, `stop()` → `disconnect()`)
- [x] 4.2 Ensure `connect()` auto-detects running WDA instances (existing `checkRunning()` logic)
- [x] 4.3 Ensure `screenshot()` returns `Buffer` (not base64 string)
- [x] 4.4 Ensure `accessibilityTree()` returns raw XML from `/source`
- [x] 4.5 Update `src/executor.ts` and `src/agent.ts` imports to use `src/core/wda-device.ts`
- [x] 4.6 Build gate: `tsc --noEmit` passes with zero errors
- [x] 4.7 CLI regression: WDA runner — same as 3.4, core pipeline verified

## 5. Core: Maestro Backend

- [x] 5.1 Create `src/core/maestro-device.ts` — refactor `MaestroClient` to implement `MobileDevice`
- [x] 5.2 Ensure `accessibilityTree()` returns JSON string from `hierarchy()`
- [x] 5.3 Update `src/executor.ts` imports to use `src/core/maestro-device.ts`
- [x] 5.4 Build gate: `tsc --noEmit` passes with zero errors

## 6. CLI Refactoring

- [x] 6.1 Extract shared API config to `src/cli/api-config.ts` (inferProvider, getApiConfig)
- [x] 6.2 Add `mcp` subcommand to Commander with flags: `--runner`, `--ios-device`, `--team-id`, `--port`
- [x] 6.3 Deduplicate `index.ts` — import from `src/cli/api-config.ts` instead of local functions
- [x] 6.4 Build gate: `tsc --noEmit` passes with zero errors
- [x] 6.5 CLI regression: same as 3.4/4.7 — refactoring didn't break anything

## 7. MCP Server Foundation

- [x] 7.1 Create `src/mcp/server.ts` — initialize MCP server with `@modelcontextprotocol/sdk` using stdio transport
- [x] 7.2 Implement lazy device connection: store config at startup, connect on first tool call
- [x] 7.3 Implement persistent session: cache `MobileDevice` instance across tool calls
- [x] 7.4 Implement session health check: detect stale WDA sessions, auto-reconnect and retry once
- [x] 7.5 Implement graceful shutdown: clean up device session on stdin close / SIGTERM

## 8. MCP Tools: Screen Observation

- [x] 8.1 Register `screenshot` tool — capture screen, compress with sharp, return as MCP image content
- [x] 8.2 Register `accessibility_tree` tool — fetch raw tree, parse with tree-parser, return text (2000-char cap, sparse check)
- [x] 8.3 Add `raw` parameter to `accessibility_tree` for returning unprocessed XML/JSON

## 9. MCP Tools: Device Actions

- [x] 9.1 Register `tap` tool — params: `{ x: number, y: number }`, validate 0-100 range
- [x] 9.2 Register `tap_text` tool — params: `{ text: string }`
- [x] 9.3 Register `input_text` tool — params: `{ text: string }`
- [x] 9.4 Register `erase_text` tool — params: `{ chars?: number }`
- [x] 9.5 Register `scroll` tool — no required params
- [x] 9.6 Register `swipe` tool — params: `{ startX, startY, endX, endY }`
- [x] 9.7 Register `back`, `hide_keyboard`, `press_key` tools
- [x] 9.8 Register `open_link` tool — params: `{ url: string }`
- [x] 9.9 Implement unified error handling: all tools return `{ success: true }` or MCP error, never crash server

## 10. MCP Tools: App Management

- [x] 10.1 Register `launch_app` tool — params: `{ bundleId: string }`
- [x] 10.2 Register `stop_app` tool — params: `{ bundleId: string }`, idempotent
- [x] 10.3 Register `device_info` tool — returns screen size, connection type, device model/OS if available
- [x] 10.4 Register `run_task` tool — params: `{ task: string, bundleId?: string }`, delegates to autonomous agent loop, returns `{ success, steps, reason }`

## 11. Integration and Verification

- [x] 11.1 Wire `mcp` CLI subcommand to start `src/mcp/server.ts`
- [x] 11.2 Test: MCP server handshake verified — tool list returns all 16 tools
- [x] 11.3 Test: screenshot tool returns image content (67KB base64 JPEG)
- [x] 11.4 Test: accessibility_tree → screenshot → device_info sequence — session persisted (single WDA connection)
- [x] 11.5 Configure Claude Code MCP settings — `.mcp.json` created with stdio transport config
- [x] 11.6 Final build gate: `tsc --noEmit` && `npm run build` both pass
- [x] 11.7 CLI regression: WDA runner pipeline verified (launch, screenshot, tree, AI decisions all work)
