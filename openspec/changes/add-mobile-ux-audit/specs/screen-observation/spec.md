## ADDED Requirements

### Requirement: Screen fingerprint helper
The system SHALL expose a helper that computes a stable, short fingerprint for the currently observed screen, usable for deduplication across steps.

#### Scenario: Fingerprint from rich tree
- **WHEN** the helper is called with a parsed accessibility tree containing 10 or more labeled elements
- **THEN** it returns an 8-character hex string derived from the MD5 of the sorted element labels

#### Scenario: Fingerprint fallback to perceptual hash
- **WHEN** the helper is called and the parsed tree is sparse (< 10 labeled elements) or empty
- **THEN** it returns an 8-character hex string derived from a perceptual hash of the screenshot buffer

#### Scenario: Same screen yields same fingerprint
- **WHEN** the helper is called twice on the same screen (no UI state change between calls)
- **THEN** both calls return the same 8-character fingerprint string

### Requirement: Accessibility tree quality grade
The tree parser SHALL return a quality grade alongside the parsed text, with values `rich`, `sparse`, or `empty`.

#### Scenario: Rich grade
- **WHEN** the parsed tree contains 10 or more labeled elements
- **THEN** the returned grade is `rich`

#### Scenario: Sparse grade
- **WHEN** the parsed tree contains 2 to 9 labeled elements
- **THEN** the returned grade is `sparse`

#### Scenario: Empty grade
- **WHEN** the parsed tree contains fewer than 2 labeled elements
- **THEN** the returned grade is `empty`

#### Scenario: Grade available without breaking existing consumers
- **WHEN** existing `run`-mode callers use the parser
- **THEN** the grade is exposed as an additional field on the parser's return value without changing the existing text output or its previously documented behavior
