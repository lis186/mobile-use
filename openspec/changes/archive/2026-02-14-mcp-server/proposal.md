## Why

phone-use is currently a monolithic autonomous agent — it has its own internal AI loop (screenshot → LLM → action). When used from AI coding assistants like Claude Code, Cursor, or Gemini CLI, this creates a **double-AI problem**: the outer agent calls phone-use, which calls its own inner LLM. The outer agent can't see the device screen, can't make its own decisions, and can't combine mobile actions with other tools (file editing, web browsing, etc.).

By exposing phone-use's capabilities as an **MCP (Model Context Protocol) server**, each AI assistant can directly observe and control mobile devices using its own intelligence — no inner AI needed.

## What Changes

- **New MCP server** (`src/mcp/server.ts`): Long-running process exposing mobile automation primitives as MCP tools, with native image support for screenshots
- **Extract core library** (`src/core/`): Separate WDA/Maestro/tree-parser from CLI spinners and AI loop, behind a `MobileDevice` interface that enables future Android support
- **New CLI subcommand** (`phone-use mcp`): Starts the MCP server, configurable via CLI flags or MCP client config
- **Keep autonomous mode**: The existing `run` command and AI agent loop remain available, also exposed as an MCP tool (`run_task`) for delegated automation
- **Session management**: MCP server maintains persistent WDA/device sessions across tool calls (no per-action startup overhead)

## Capabilities

### New Capabilities

- `mcp-transport`: MCP server lifecycle, stdio transport, session management, and device connection handling
- `screen-observation`: Screenshot capture (returned as MCP image content) and accessibility tree retrieval (parsed text) as MCP tools
- `device-actions`: Tap, tapText, inputText, scroll, swipe, back, pressKey, hideKeyboard, openLink as individual MCP tools with structured parameters
- `app-management`: Launch, stop, and list apps as MCP tools; device info queries (screen size, OS version)
- `mobile-device-interface`: Platform-agnostic `MobileDevice` interface abstracting WDA (iOS), future ADB (Android), and Maestro backends

### Modified Capabilities

_(none — no existing specs)_

## Impact

- **Code structure**: Major refactoring — move `src/wda.ts`, `src/maestro.ts`, tree parser into `src/core/`; current `src/agent.ts` and `src/executor.ts` become consumers of the core library
- **Dependencies**: Add `@modelcontextprotocol/sdk` for MCP server implementation
- **Distribution**: Package must work as both `npx phone-use mcp` (stdio server) and `npx phone-use run` (autonomous agent)
- **Backwards compatible**: Existing CLI `run` command and behavior unchanged
- **Future-enabling**: `MobileDevice` interface is the prerequisite for Android (ADB) and iOS Simulator (simctl) backends
