## ADDED Requirements

### Requirement: Screenshot tool returns MCP image content
The system SHALL provide a `screenshot` MCP tool that captures the device screen and returns it as native MCP image content (base64-encoded JPEG inside an MCP image content block).

#### Scenario: Capture screenshot
- **WHEN** the AI client calls the `screenshot` tool
- **THEN** the server captures the device screen, compresses it (JPEG, resized), and returns an MCP response with `type: "image"` content

#### Scenario: Screenshot optimization
- **WHEN** a screenshot is captured
- **THEN** the image is resized and JPEG-compressed (using the existing `sharp` pipeline) to stay under ~80KB, suitable for MCP message size limits

#### Scenario: Screenshot without device connection
- **WHEN** `screenshot` is called before any device is connected
- **THEN** the server triggers lazy device connection, captures the screenshot, and returns it

### Requirement: Accessibility tree tool returns parsed text
The system SHALL provide an `accessibility_tree` MCP tool that returns a concise text representation of the current screen's UI element hierarchy.

#### Scenario: Fetch accessibility tree
- **WHEN** the AI client calls the `accessibility_tree` tool
- **THEN** the server fetches the raw tree from the device (WDA XML or Maestro JSON), parses it into a compact text format, and returns it as MCP text content

#### Scenario: Parsed tree format
- **WHEN** the tree is parsed
- **THEN** each element is formatted as `[Type] "label" (x1,y1 - x2,y2)` with percentage-based coordinates, only including elements with labels or accessibility identifiers

#### Scenario: Tree size cap
- **WHEN** the parsed tree exceeds 2000 characters
- **THEN** the output is truncated at the 2000-character boundary with a `... (truncated)` suffix

#### Scenario: Sparse tree handling
- **WHEN** the parsed tree contains fewer than 2 labeled elements (e.g., splash screen, WebView)
- **THEN** the tool returns an empty result with a message indicating the tree is too sparse to be useful

### Requirement: Raw tree option for advanced use
The system SHALL support a `raw` parameter on the `accessibility_tree` tool for returning the unprocessed tree data.

#### Scenario: Raw tree request
- **WHEN** `accessibility_tree` is called with `{ raw: true }`
- **THEN** the server returns the raw XML (WDA) or JSON (Maestro) without parsing or truncation
