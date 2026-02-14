## ADDED Requirements

### Requirement: Platform-agnostic MobileDevice interface
The system SHALL define a `MobileDevice` TypeScript interface that abstracts all device interaction behind a common contract, enabling swappable backends (WDA, Maestro, future ADB/simctl).

#### Scenario: Interface contract
- **WHEN** a new backend is implemented
- **THEN** it implements the `MobileDevice` interface with all required methods: `connect()`, `disconnect()`, `isConnected()`, `screenshot()`, `accessibilityTree()`, `screenSize()`, `tap()`, `tapText()`, `doubleTap()`, `longPress()`, `inputText()`, `eraseText()`, `scroll()`, `swipe()`, `back()`, `hideKeyboard()`, `openLink()`, `pressKey()`, `launchApp()`, `stopApp()`

#### Scenario: Coordinate system consistency
- **WHEN** any backend implements `tap()`, `swipe()`, or coordinate-based actions
- **THEN** coordinates are expressed as percentages (0-100) — the backend converts to device pixels internally

### Requirement: WDA backend implements MobileDevice
The system SHALL refactor `WDAClient` to implement the `MobileDevice` interface and move it to `src/core/wda-device.ts`.

#### Scenario: WDA method mapping
- **WHEN** `WDAClient` is refactored
- **THEN** existing methods map to the interface: `start()` → `connect()`, `stop()` → `disconnect()`, existing action methods retain their behavior

#### Scenario: Session reuse
- **WHEN** WDA is already running externally (e.g., started by user)
- **THEN** `connect()` detects the running instance and creates a session without managing the WDA process lifecycle

### Requirement: Maestro backend implements MobileDevice
The system SHALL refactor `MaestroClient` to implement the `MobileDevice` interface and move it to `src/core/maestro-device.ts`.

#### Scenario: Maestro method mapping
- **WHEN** `MaestroClient` is refactored
- **THEN** existing Maestro CLI wrapper methods map to the interface methods

### Requirement: Screenshot returns Buffer
The `screenshot()` method SHALL return a raw `Buffer` (PNG or JPEG bytes), not a base64 string. Callers choose the encoding.

#### Scenario: Screenshot as Buffer
- **WHEN** `screenshot()` is called on any backend
- **THEN** it returns a `Buffer` containing the image data

### Requirement: Accessibility tree returns raw string
The `accessibilityTree()` method SHALL return the raw tree data as a string (XML for WDA, JSON for Maestro). Parsing into display format is the caller's responsibility.

#### Scenario: WDA returns XML
- **WHEN** `accessibilityTree()` is called on the WDA backend
- **THEN** it returns the raw XML string from WDA's `/source` endpoint

#### Scenario: Maestro returns JSON
- **WHEN** `accessibilityTree()` is called on the Maestro backend
- **THEN** it returns the JSON string from Maestro's hierarchy command

### Requirement: Core module has no UI or transport dependencies
The `src/core/` module SHALL have zero dependencies on CLI libraries (Commander, ora), AI SDK, or MCP SDK. It is a pure library.

#### Scenario: Import isolation
- **WHEN** `src/core/` files are analyzed for imports
- **THEN** they import only from Node.js built-ins, `src/core/` siblings, and utility libraries (e.g., `sharp` for image processing)

### Requirement: Tree parser extracted to core
The system SHALL extract `parseAccessibilityTree()`, `parseWDATree()`, and `parseMaestroTree()` from `src/agent.ts` into `src/core/tree-parser.ts`.

#### Scenario: Shared parser
- **WHEN** both the MCP server and the autonomous agent need to parse a tree
- **THEN** they import the same `parseAccessibilityTree()` function from `src/core/tree-parser.ts`
