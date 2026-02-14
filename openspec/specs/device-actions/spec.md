## ADDED Requirements

### Requirement: Tap action tool
The system SHALL provide a `tap` MCP tool that taps at specified coordinates on the device screen.

#### Scenario: Tap by coordinates
- **WHEN** the AI client calls `tap` with `{ x: 50, y: 30 }`
- **THEN** the server taps at coordinates (50%, 30%) on the device screen, using percentage-based coordinates (0-100)

#### Scenario: Invalid coordinates
- **WHEN** `tap` is called with coordinates outside the 0-100 range
- **THEN** the tool returns an MCP error response with a descriptive validation message

### Requirement: Tap text action tool
The system SHALL provide a `tap_text` MCP tool that taps on a visible text element by exact label match.

#### Scenario: Tap text element
- **WHEN** the AI client calls `tap_text` with `{ text: "Settings" }`
- **THEN** the server locates the element with matching text and taps on it

#### Scenario: Text not found
- **WHEN** `tap_text` is called with text that doesn't match any visible element
- **THEN** the tool returns an MCP error indicating the text was not found on screen

### Requirement: Text input tool
The system SHALL provide an `input_text` MCP tool that types text into the currently focused field.

#### Scenario: Type text
- **WHEN** the AI client calls `input_text` with `{ text: "hello world" }`
- **THEN** the server inputs the text character-by-character into the active text field

### Requirement: Erase text tool
The system SHALL provide an `erase_text` MCP tool that deletes characters from the currently focused field.

#### Scenario: Erase characters
- **WHEN** the AI client calls `erase_text` with `{ chars: 5 }`
- **THEN** the server sends 5 backspace/delete key events

#### Scenario: Erase all (default)
- **WHEN** `erase_text` is called without a `chars` parameter
- **THEN** the server erases a reasonable default number of characters (e.g., 50)

### Requirement: Scroll action tool
The system SHALL provide a `scroll` MCP tool that scrolls the current view.

#### Scenario: Scroll down (default)
- **WHEN** the AI client calls `scroll` with no parameters
- **THEN** the server performs a downward scroll gesture on the device

### Requirement: Swipe action tool
The system SHALL provide a `swipe` MCP tool for arbitrary directional gestures.

#### Scenario: Swipe gesture
- **WHEN** the AI client calls `swipe` with `{ startX: 50, startY: 80, endX: 50, endY: 20 }`
- **THEN** the server performs a swipe from (50%, 80%) to (50%, 20%) using percentage coordinates

### Requirement: Back navigation tool
The system SHALL provide a `back` MCP tool that navigates back in the current app.

#### Scenario: Go back
- **WHEN** the AI client calls `back`
- **THEN** the server performs a back navigation action (swipe-from-edge on iOS, back button on Android)

### Requirement: Keyboard management tool
The system SHALL provide a `hide_keyboard` MCP tool to dismiss the on-screen keyboard.

#### Scenario: Dismiss keyboard
- **WHEN** the AI client calls `hide_keyboard`
- **THEN** the server dismisses the software keyboard if it is currently visible

### Requirement: URL opening tool
The system SHALL provide an `open_link` MCP tool to open URLs or deep links on the device.

#### Scenario: Open URL
- **WHEN** the AI client calls `open_link` with `{ url: "https://example.com" }`
- **THEN** the device opens the URL in its default browser or appropriate app

#### Scenario: Open deep link
- **WHEN** the AI client calls `open_link` with `{ url: "myapp://screen/settings" }`
- **THEN** the device opens the deep link in the registered app

### Requirement: Key press tool
The system SHALL provide a `press_key` MCP tool for sending individual key events.

#### Scenario: Press key
- **WHEN** the AI client calls `press_key` with `{ key: "home" }`
- **THEN** the server sends the specified key event to the device

### Requirement: All action tools return confirmation
All action tools SHALL return a success/failure response indicating whether the action completed.

#### Scenario: Action succeeds
- **WHEN** any action tool completes successfully
- **THEN** it returns `{ success: true }` as MCP text content

#### Scenario: Action fails
- **WHEN** any action tool fails (device error, timeout, etc.)
- **THEN** it returns an MCP error response with a descriptive message, without crashing the server
