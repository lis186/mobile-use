## ADDED Requirements

### Requirement: Launch app tool
The system SHALL provide a `launch_app` MCP tool that launches an app by bundle identifier.

#### Scenario: Launch by bundle ID
- **WHEN** the AI client calls `launch_app` with `{ bundleId: "com.apple.Preferences" }`
- **THEN** the server launches the Settings app on the connected device

#### Scenario: App not installed
- **WHEN** `launch_app` is called with a bundle ID that is not installed on the device
- **THEN** the tool returns an MCP error response indicating the app was not found

### Requirement: Stop app tool
The system SHALL provide a `stop_app` MCP tool that terminates a running app.

#### Scenario: Stop running app
- **WHEN** the AI client calls `stop_app` with `{ bundleId: "com.apple.Preferences" }`
- **THEN** the server terminates the app on the device

#### Scenario: App not running
- **WHEN** `stop_app` is called for an app that is not currently running
- **THEN** the tool returns success (idempotent — no error)

### Requirement: Device info tool
The system SHALL provide a `device_info` MCP tool that returns information about the connected device.

#### Scenario: Query device info
- **WHEN** the AI client calls `device_info`
- **THEN** the server returns structured information including: screen width, screen height, device model (if available), OS version (if available), and connection type (WDA/Maestro)

#### Scenario: Device info triggers connection
- **WHEN** `device_info` is called and no device is connected yet
- **THEN** the server triggers lazy device connection and returns the device information

### Requirement: Run task delegation tool
The system SHALL provide a `run_task` MCP tool that delegates a complete task to the built-in autonomous AI agent.

#### Scenario: Delegate a task
- **WHEN** the AI client calls `run_task` with `{ task: "Open Settings and go to About", bundleId: "com.apple.Preferences" }`
- **THEN** the server runs the autonomous agent loop (screenshot → LLM → action) until the task completes or max steps is reached

#### Scenario: Task result
- **WHEN** the autonomous agent completes (success or failure)
- **THEN** the tool returns `{ success: boolean, steps: number, reason: string }` as MCP text content

#### Scenario: Task timeout
- **WHEN** the autonomous agent reaches the maximum step limit without completing
- **THEN** the tool returns `{ success: false, steps: <maxSteps>, reason: "Max steps reached" }`

#### Scenario: Run task requires AI configuration
- **WHEN** `run_task` is called but no AI API key is configured (env vars)
- **THEN** the tool returns an MCP error explaining that an API key is required for autonomous mode
