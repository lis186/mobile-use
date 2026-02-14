## ADDED Requirements

### Requirement: MCP server starts via CLI subcommand
The system SHALL provide a `mobile-use mcp` CLI subcommand that starts an MCP server using stdio transport (JSON-RPC over stdin/stdout).

#### Scenario: Start MCP server with default settings
- **WHEN** user runs `mobile-use mcp`
- **THEN** the server starts on stdio transport and outputs MCP initialization handshake

#### Scenario: Start MCP server with device flags
- **WHEN** user runs `mobile-use mcp --runner wda --ios-device <udid> --team-id <id>`
- **THEN** the server starts and uses these as default device connection parameters for subsequent tool calls

#### Scenario: Configure in Claude Code
- **WHEN** user adds `{"mcpServers": {"mobile-use": {"command": "npx", "args": ["mobile-use", "mcp", "--runner", "wda", "--ios-device", "<udid>", "--team-id", "<id>"]}}}` to their MCP config
- **THEN** Claude Code launches the MCP server as a child process and discovers all available tools

### Requirement: Lazy device connection
The server SHALL NOT connect to a device at startup. Connection SHALL occur on the first tool call that requires a device.

#### Scenario: Server starts without device
- **WHEN** the MCP server starts and no device is plugged in
- **THEN** the server initializes successfully and reports its tool list

#### Scenario: First tool call triggers connection
- **WHEN** the first `screenshot` or action tool is called
- **THEN** the server connects to the device using configured parameters and caches the session

#### Scenario: Connection failure on tool call
- **WHEN** a tool call triggers device connection and the device is not available
- **THEN** the tool returns an MCP error response with a descriptive message (not a server crash)

### Requirement: Persistent session across tool calls
The server SHALL maintain a single device session across multiple tool calls within the same MCP server lifetime.

#### Scenario: Sequential tool calls reuse session
- **WHEN** `screenshot` is called, then `tap`, then `screenshot` again
- **THEN** all three calls use the same underlying WDA/Maestro session without reconnection

#### Scenario: Session recovery on stale connection
- **WHEN** a tool call fails because the WDA session has expired
- **THEN** the server automatically reconnects and retries the tool call once

### Requirement: Graceful shutdown
The server SHALL clean up device sessions when the MCP connection closes.

#### Scenario: Client disconnects
- **WHEN** the MCP client (Claude Code) terminates or disconnects
- **THEN** the server deletes the device session and exits cleanly without orphaned processes
