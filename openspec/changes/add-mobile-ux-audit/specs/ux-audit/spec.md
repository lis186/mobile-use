## ADDED Requirements

### Requirement: Audit command entry point
The system SHALL provide a `phone-use audit <bundleId>` CLI command that launches an autonomous UX audit of the target mobile app.

#### Scenario: Start audit on physical device
- **WHEN** the user runs `phone-use audit com.example.app --runner wda --ios-device <udid> --team-id <id>`
- **THEN** the system launches WebDriverAgent, opens the target app, and begins the audit loop

#### Scenario: Start audit on simulator
- **WHEN** the user runs `phone-use audit com.example.app --runner maestro`
- **THEN** the system opens the target app on the booted simulator and begins the audit loop

#### Scenario: Skip app launch for pre-authenticated state
- **WHEN** the user runs `phone-use audit com.example.app --skip-launch`
- **THEN** the system attaches to the currently foregrounded app without relaunching it, preserving login state

#### Scenario: Audit without bundle ID is rejected
- **WHEN** the user runs `phone-use audit` with no bundle ID and no `--skip-launch`
- **THEN** the command exits with a non-zero status and a usage message

### Requirement: Structured audit output via generateObject
The audit agent SHALL produce its per-step decision using `generateObject()` with a Zod schema, not free-form text parsing.

#### Scenario: Valid structured decision returned
- **WHEN** the audit agent is called with a screenshot and accessibility tree
- **THEN** it returns an object matching the audit schema containing a `navigation` action and an optional `audit` block with `screenName`, `issues`, and `screenScore`

#### Scenario: Parse success rate target
- **WHEN** the audit runs across at least 25 steps
- **THEN** the `generateObject` success rate for that run is ≥ 98 % (counted as successful calls / total decision calls)

#### Scenario: Fallback on NoObjectGeneratedError
- **WHEN** `generateObject` throws `NoObjectGeneratedError` on a step
- **THEN** the executor falls back to `generateText()` with a navigation-only prompt, preserving the step and logging the fallback event

### Requirement: Three-layer UX analysis quality control
Every issue the agent reports SHALL be subject to evidence-required schema validation, comparative-anchoring prompt grounding, and anti-pattern filtering.

#### Scenario: Issue without evidence is rejected by schema
- **WHEN** the agent attempts to return an issue with an `evidence` field shorter than 20 characters
- **THEN** the schema validation fails and the issue is dropped from that step's output

#### Scenario: Issue below confidence threshold is filtered
- **WHEN** the agent returns an issue with `confidence < 60`
- **THEN** the executor drops that issue before it reaches the report

#### Scenario: Comparative anchoring provided in prompt
- **WHEN** the audit system prompt is built
- **THEN** it includes explicit iOS Human Interface Guidelines reference points (minimum 44×44 pt tap target, 4.5:1 contrast ratio for normal text, 11 pt minimum system font)

#### Scenario: Anti-patterns listed in prompt
- **WHEN** the audit system prompt is built
- **THEN** it explicitly instructs the agent NOT to report standard platform navigation, normal loading spinners, or standard button styles as UX issues, and includes one GOOD and one BAD example issue

### Requirement: Systematic exploration via screen fingerprinting
The audit executor SHALL track visited screens and prioritize unvisited navigation targets to avoid walking in circles.

#### Scenario: Screen fingerprinting with rich accessibility tree
- **WHEN** the current screen has a rich accessibility tree (≥ 10 labeled elements)
- **THEN** the screen fingerprint is computed as the MD5 of sorted element labels, truncated to the first 8 hex characters

#### Scenario: Screen fingerprinting with sparse or empty tree
- **WHEN** the current screen has a sparse or empty accessibility tree
- **THEN** the screen fingerprint is computed as a perceptual hash of the screenshot buffer, truncated to the first 8 hex characters

#### Scenario: Visited-map injection into prompt
- **WHEN** the audit executor prepares the prompt for the next step
- **THEN** it injects an `EXPLORATION STATE` block listing visited screens with counts, unvisited navigation targets extracted from the current tree, and the remaining step budget

#### Scenario: Coverage target for a 25-step audit
- **WHEN** a 25-step audit completes on an app with at least 8 reachable top-level screens
- **THEN** the visited map contains at least 8 distinct fingerprints

### Requirement: Accessibility tree quality grading
The system SHALL grade the current screen's accessibility tree as `rich`, `sparse`, or `empty` and communicate the grade to the agent.

#### Scenario: Rich tree grading
- **WHEN** the parsed tree contains ≥ 10 labeled elements
- **THEN** the grade is `rich` and the tree is used for fingerprinting, nav-target extraction, and analysis grounding

#### Scenario: Sparse tree grading
- **WHEN** the parsed tree contains 2–9 labeled elements
- **THEN** the grade is `sparse`, the tree is used only for fingerprinting, and the prompt tells the agent to rely primarily on visual analysis

#### Scenario: Empty tree grading
- **WHEN** the parsed tree contains fewer than 2 labeled elements
- **THEN** the grade is `empty`, fingerprinting falls back to the perceptual hash of the screenshot, and the prompt tells the agent to operate in visual-only mode

### Requirement: Evidence capture synchronous with discovery
When the agent reports one or more issues on a step, the executor SHALL save the exact screenshot of that step as evidence for every reported issue before advancing to the next step.

#### Scenario: Issue evidence saved as deduplicated JPEG
- **WHEN** the agent returns an issue with ID `ISSUE-003` on a step whose screenshot buffer is in memory
- **THEN** the executor writes an optimized JPEG to `${outputDir}/screenshots/ISSUE-003.jpg` before executing the navigation action, using content-hash dedup so identical bytes are stored only once on disk

#### Scenario: Multiple issues from one step share storage
- **WHEN** a single step produces three issues
- **THEN** three file entries exist under `screenshots/`, each resolving to the same underlying JPEG content via symlink or copy

#### Scenario: Evidence path referenced in the report
- **WHEN** the final report is written
- **THEN** every issue entry includes a relative path to its saved screenshot, resolvable from the report's location

### Requirement: Markdown audit report generation
The audit command SHALL write a single Markdown report file summarizing the run, every issue found, the screen map, a performance summary, and suggested next steps.

#### Scenario: Report header
- **WHEN** `report.md` is rendered
- **THEN** the header contains bundle ID, audit date and time, device info (runner + iOS version), model name, wall-clock duration, step count (with onboarding-excluded count), coverage (unique screens visited), and total cost estimate

#### Scenario: Severity summary and top concern
- **WHEN** `report.md` is rendered
- **THEN** it contains a severity count table (High / Medium / Low) and a one-line "top concern" pointing the reader at the most urgent cluster of issues

#### Scenario: Per-issue section content
- **WHEN** an issue is rendered in the report
- **THEN** it contains: issue ID, severity, title, screen name, violated principle(s), affected persona(s), confidence, step number, an embedded annotated screenshot, AI observation (`evidence`), AI reasoning for the step, recommendation, and a "how to verify the fix" snippet with a concrete re-audit command

#### Scenario: Screen map section
- **WHEN** `report.md` is rendered
- **THEN** it contains an indented tree of visited screens in discovery order, with onboarding screens listed separately and marked as not counted toward coverage

#### Scenario: Performance summary
- **WHEN** `report.md` is rendered
- **THEN** it contains a table with P50 / P95 / average for screenshot, AI decision, action, stability wait, and total per-step time, plus total input/output tokens and cost estimate

#### Scenario: Next-steps section
- **WHEN** `report.md` is rendered
- **THEN** it contains a bulleted "Next steps" list prioritizing High-severity fixes first, offering a scoped re-audit command, and listing Medium/Low items separately

#### Scenario: Output directory layout
- **WHEN** an audit runs with default options
- **THEN** outputs are written under `./audit-output/<timestamp>-<bundleId>/` containing `report.md`, `issues.jsonl`, `steps.jsonl`, `timings.json`, `screenshots/` (raw content-hashed JPEGs with issueId symlinks), and `annotated/` (annotated JPEGs per step)

#### Scenario: Partial report on early termination
- **WHEN** the audit terminates early (e.g., app crashed or user pressed Ctrl-C)
- **THEN** a partial report is still written with all issues discovered so far, a prominent banner at the top of `report.md` explaining why the run ended early, and the `AuditError` code (if any)

### Requirement: Annotated screenshots for every step
Every audit step SHALL produce an annotated screenshot that visually shows the AI's action and intent, and the final report SHALL reference the annotated version (not the raw screenshot) as evidence.

#### Scenario: Annotation overlay content
- **WHEN** the executor completes a step with a navigation action
- **THEN** an annotated JPEG is written to `annotated/step-NN.jpg` containing the raw screenshot as background, a red circle at the tap coordinate, a connector line to a text card, and the text card containing `Action: <type>`, `Target: <AI's target description>`, and `Why: <first sentence of reasoning>`

#### Scenario: Annotation for non-tap actions
- **WHEN** the action is `scroll`, `swipe`, `inputText`, or similar non-point action
- **THEN** the annotation uses an action-appropriate marker (arrow for swipe/scroll, text caret for inputText) instead of a circle, with the same Action/Target/Why text card

#### Scenario: Report references annotated images
- **WHEN** the report renders a per-issue section
- **THEN** the embedded image path points at `annotated/step-NN.jpg`, not the raw `screenshots/` path

#### Scenario: Raw screenshot still saved
- **WHEN** an annotated screenshot is produced
- **THEN** the raw content-hashed JPEG is still saved under `screenshots/` for fidelity, referenced by the annotated file's sidecar metadata

### Requirement: Optional live viewer
The audit command SHALL provide an opt-in live viewer that streams annotated screenshots to a local web page as the run progresses.

#### Scenario: Live viewer opt-in
- **WHEN** the user passes `--live` on the CLI
- **THEN** the executor starts a local HTTP server on port 7330 (override via `--live-port`) and automatically opens the viewer URL in the user's default browser

#### Scenario: Live viewer layout
- **WHEN** the live viewer is open during an audit run
- **THEN** it displays the current step's annotated image in a main panel, a thumbnail strip of the last 5 steps in a side rail, the current step number and total steps, and the running issue count

#### Scenario: SSE streaming
- **WHEN** a new annotated screenshot is written
- **THEN** the server pushes it to the viewer via Server-Sent Events within 500 ms

#### Scenario: Live viewer off by default
- **WHEN** the user runs `phone-use audit` without `--live`
- **THEN** no HTTP server is started, no browser is opened, and there is no per-step SSE overhead

### Requirement: System dialog handling guidance
The audit agent SHALL be instructed, via its system prompt, to dismiss iOS system dialogs without reporting them as UX issues.

#### Scenario: Permission dialog encountered
- **WHEN** the agent sees an iOS permission dialog (camera, location, notifications, Face ID, etc.)
- **THEN** the agent issues a navigation action that taps the most permissive safe action (Allow / OK / Later)

#### Scenario: System dialog not reported as issue
- **WHEN** an iOS system dialog is on screen
- **THEN** no UX issue is reported for the dialog's visual design or placement

### Requirement: Cost and step budget safeguards
The audit command SHALL enforce sensible defaults and warnings on step count and expected cost.

#### Scenario: Default max steps
- **WHEN** the user does not pass `--max-steps`
- **THEN** the audit uses a default of 25 steps

#### Scenario: High step count warning
- **WHEN** the user passes `--max-steps > 40`
- **THEN** the CLI prints a warning about expected cost before starting the audit

### Requirement: Stateless per-screen analysis
The audit agent SHALL NOT maintain conversation history across steps. Each step is a single-turn call with the current screenshot, tree, and exploration state block as the sole context.

#### Scenario: No conversation history in audit
- **WHEN** the audit agent processes step N
- **THEN** the API call contains only: system prompt, current screenshot, current tree block, and current exploration state block — no messages from steps 1 through N-1

#### Scenario: Exploration state block contains recent actions
- **WHEN** the exploration state block is built for step N
- **THEN** it includes a `Last 3 actions:` line showing the three most recent actions to preserve navigation context without conversation history

### Requirement: Action-type-based screen stability wait
After navigation actions in audit mode, the executor SHALL wait for the screen to stabilize before capturing the next screenshot.

#### Scenario: Navigation action triggers stability wait
- **WHEN** the executor completes a navigation action (tap, tapText, back, launchApp, openLink, pressKey, doubleTap)
- **THEN** it calls `waitForScreenStable(maxMs=2000, intervalMs=250)` before proceeding

#### Scenario: Non-navigation action uses fixed delay
- **WHEN** the executor completes a non-navigation action (scroll, swipe, inputText, hideKeyboard, wait)
- **THEN** it uses the existing `getPostActionDelay()` sleep without stability polling

#### Scenario: Configurable stability timeout
- **WHEN** the user passes `--stable-timeout <ms>` on the CLI
- **THEN** the stability wait uses the provided value as `maxMs` instead of the default 2000

### Requirement: Per-step performance instrumentation
The audit executor SHALL record timing and token usage for every step and produce a summary at the end.

#### Scenario: Timing recorded per step
- **WHEN** a step completes in audit mode
- **THEN** the executor records `{ step, screenshot_ms, ai_ms, action_ms, sleep_ms, total_ms, input_tokens, output_tokens }` for that step

#### Scenario: Summary printed at end
- **WHEN** the audit run completes
- **THEN** the console prints P50, P95, and average for `ai_ms`, `screenshot_ms`, and `total_ms`, plus total input/output tokens and estimated cost

#### Scenario: Timing data persisted
- **WHEN** the audit run completes
- **THEN** `timings.json` is written to the output directory containing the full array of per-step timing records plus the summary statistics

### Requirement: Append-only JSONL streaming persistence
The executor SHALL stream findings to disk as append-only JSONL, not buffer them in memory until the end.

#### Scenario: Step data appended after each step
- **WHEN** a step completes
- **THEN** a JSON line is appended to `steps.jsonl` containing `{ step, fingerprint, action, reasoning, issues_found, screen_name, timing, onboarding }`

#### Scenario: Issue data appended on discovery
- **WHEN** the agent reports an issue
- **THEN** a JSON line is appended to `issues.jsonl` containing the full issue record

#### Scenario: Graceful shutdown writes report from JSONL
- **WHEN** the audit is interrupted by SIGINT
- **THEN** the async shutdown handler calls `finalizeReport()` which reads `issues.jsonl` and `steps.jsonl` and renders `report.md`

#### Scenario: SIGKILL leaves recoverable data
- **WHEN** the audit is killed with SIGKILL (no handler)
- **THEN** `steps.jsonl` and `issues.jsonl` contain all data up to the last completed step; they can be manually fed to the report renderer

### Requirement: Typed error taxonomy
The audit executor SHALL raise typed `AuditError` instances with discriminated error codes instead of raw exceptions.

#### Scenario: Driver not ready
- **WHEN** WDA or maestro fails to start
- **THEN** the executor throws `AuditError` with code `E_DRIVER_NOT_READY` and a hint to restart the driver

#### Scenario: Model incompatible
- **WHEN** `generateObject` fails 3 consecutive times
- **THEN** the executor throws `AuditError` with code `E_MODEL_INCOMPATIBLE` and a hint to switch to a supported model

#### Scenario: Device locked or sleeping
- **WHEN** screenshots fail 3 consecutive times but the driver process is alive
- **THEN** the executor throws `AuditError` with code `E_DEVICE_LOCKED` and a hint to unlock the device

#### Scenario: User abort
- **WHEN** the user presses Ctrl+C
- **THEN** the executor catches SIGINT, writes the partial report, and exits with `AuditError` code `E_USER_ABORTED`

### Requirement: Onboarding and tutorial skip guidance
The audit agent SHALL be instructed to skip first-run tutorials and onboarding screens without counting them as audit coverage.

#### Scenario: Onboarding screen detected
- **WHEN** the agent sees a tutorial, walkthrough, welcome screen, or "What's New" dialog
- **THEN** it dismisses via Skip, Got it, Continue, or Later without performing UX analysis on the screen

#### Scenario: Onboarding steps excluded from coverage
- **WHEN** the audit summary reports screen coverage
- **THEN** steps tagged as `onboarding: true` in `steps.jsonl` are excluded from the unique-screen count

### Requirement: Proactive Gemini rate limiting with hard per-step timeout
The audit executor SHALL enforce a configurable rate limit on AI calls and a hard per-step timeout so a rate-limited API cannot hang the audit.

#### Scenario: Default rate limit on free-tier Gemini
- **WHEN** an audit runs without `--rpm-limit`
- **THEN** the executor throttles AI calls to 12 requests per 60 seconds (20 % headroom under the free-tier 15 RPM limit)

#### Scenario: Rate limiter wait is visible
- **WHEN** the rate limiter blocks a call because the window is full
- **THEN** the console prints `⏸ Rate limit: waiting Xs (N/N calls in last min)` with a numeric wait time so the user knows the run is throttled, not hung

#### Scenario: Configurable rate limit for paid tier
- **WHEN** the user passes `--rpm-limit 1000`
- **THEN** the rate limiter effectively disables throttling for paid-tier users while the plumbing remains available for rollback

#### Scenario: Hard per-step timeout
- **WHEN** a single `generateObject` call exceeds 45 seconds of wall-clock time (including all internal retries)
- **THEN** the executor aborts the call via `Promise.race` and raises `AuditError` with code `E_NETWORK_TIMEOUT`

#### Scenario: maxRetries reduced in audit mode
- **WHEN** the audit agent calls `generateObject`
- **THEN** it sets `maxRetries: 1` rather than the SDK default of 2, since the rate limiter now prevents the bursts that retries were meant to absorb

### Requirement: Specimen screen context filter
The audit executor SHALL drop contrast, readability, and legibility issues when the current screen is a font preview, specimen, or similar demonstration screen.

#### Scenario: Font preview screen detected by screen name
- **WHEN** the screen name matches a font/specimen pattern (contains "font", "字體", "typeface", "字型", "specimen", or "preview.*font")
- **AND** the issue's principle or title contains "contrast", "readability", or "legibility"
- **THEN** the issue is dropped before persistence and not included in the report

#### Scenario: Prompt-level context filter
- **WHEN** the audit system prompt is built
- **THEN** it includes a CONTEXT FILTER section before the quality control layers, explicitly instructing the agent not to flag demonstrated visual properties on specimen screens

#### Scenario: BAD example for specimen screen
- **WHEN** the audit system prompt is built
- **THEN** it includes a BAD example showing a font preview false positive with an explanation of why it is wrong

### Requirement: Cross-screen principle-based dedup
The report renderer SHALL deduplicate issues that share the same principle and similar content across different screens, not only within the same screen.

#### Scenario: Same-screen fuzzy dedup
- **WHEN** two issues on the same screen have title bigram Jaccard similarity ≥ 0.5
- **THEN** only the first-discovered issue is kept

#### Scenario: Cross-screen principle dedup
- **WHEN** two issues on different screens share the same principle AND have title bigram Jaccard similarity ≥ 0.5 OR evidence bigram Jaccard similarity ≥ 0.5
- **THEN** only the first-discovered issue is kept

### Requirement: Consecutive swipe escape heuristic
The audit executor SHALL detect when the agent is stuck in paginated content and force an escape.

#### Scenario: Swipe loop detected
- **WHEN** the agent performs 4 consecutive swipe or scroll actions without any other action type
- **THEN** the executor forces a `back` navigation action and injects a STUCK message into `recentActions`

#### Scenario: Swipe counter reset
- **WHEN** the agent performs any non-swipe action (tap, tapText, back, etc.)
- **THEN** the consecutive swipe counter resets to 0

### Requirement: Subtree escape via app relaunch
When the agent is trapped in a subtree (repeatedly revisiting known screens), the executor SHALL relaunch the app to return to the root screen.

#### Scenario: Stuck escape triggers relaunch instead of back
- **WHEN** the consecutive swipe escape triggers AND the agent has been in the same area for multiple stuck cycles
- **THEN** the executor relaunches the app (returning to its root screen) instead of navigating back one level

#### Scenario: Relaunch injects exploration guidance
- **WHEN** the app is relaunched due to a stuck escape
- **THEN** a message is injected into `recentActions` instructing the agent to explore a completely different section

### Requirement: Pre-audit step budget estimation
Before the audit loop begins, the executor SHALL estimate the number of steps needed for shallow coverage and display the estimate to the user.

#### Scenario: Section count from home screen
- **WHEN** the audit starts and the app's home screen is loaded
- **THEN** the executor parses the accessibility tree to count interactive sections (tappable rows with navigation affordances)

#### Scenario: Coverage estimate displayed
- **WHEN** the section count is determined
- **THEN** the console displays the estimated steps needed (sections × 3), the configured step budget, and the expected coverage percentage

#### Scenario: No AI call required
- **WHEN** the step budget estimation runs
- **THEN** it uses only the accessibility tree parser — no LLM call is made and no tokens are consumed

### Requirement: Phase 1 runner and device scope
Phase 1 of the audit feature SHALL target iOS 26 simulators only via the `xctest` runner.

#### Scenario: Default runner for audit
- **WHEN** the user runs `phone-use audit` without `--runner`
- **THEN** the executor selects the `xctest` runner and targets the booted iOS 26 simulator

#### Scenario: Physical device explicitly unsupported in Phase 1
- **WHEN** the user passes `--runner wda` or `--ios-device <udid>` with an audit command in Phase 1
- **THEN** the CLI prints a clear message that physical-device audit is a Phase 2 feature and exits with a non-zero status

#### Scenario: Known limitation documented
- **WHEN** a reader consults `CLAUDE.md`
- **THEN** a "Known limitations" section clearly states that iOS 26 physical device is out of scope for Phase 1 and is parked as a Phase 2 research task

### Requirement: Phase 1 dogfood target apps
Phase 1 dogfood runs SHALL exercise three specific Apple built-in apps to cover the tri-state tree quality grades without PII or ToS risk.

#### Scenario: Rich tree coverage
- **WHEN** Phase 1 dogfood is executed
- **THEN** one run targets `com.apple.Preferences` (Settings), validating nav-target extraction and visited-map behavior on a rich accessibility tree

#### Scenario: Sparse tree coverage
- **WHEN** Phase 1 dogfood is executed
- **THEN** one run targets `com.apple.Maps`, validating perceptual-hash fingerprint fallback on a sparse tree

#### Scenario: Empty tree / WebView coverage
- **WHEN** Phase 1 dogfood is executed
- **THEN** one run targets `com.apple.mobilesafari`, validating visual-only mode on a WebView-dominated surface

### Requirement: Concurrent audit prevention
The audit executor SHALL prevent two audit runs on the same device at the same time.

#### Scenario: Lock acquired on start
- **WHEN** an audit begins on a device
- **THEN** a lockfile `/tmp/phone-use-audit-<device-id>.lock` is created with the process PID

#### Scenario: Second audit blocked
- **WHEN** a second `phone-use audit` is started targeting the same device while the first is running
- **THEN** the second run exits immediately with an error message identifying the blocking PID

#### Scenario: Lock cleaned up on exit
- **WHEN** the audit finishes (success, failure, or interrupt)
- **THEN** the lockfile is deleted

### Requirement: Run mode regression safety
Adding the audit mode MUST NOT change the behavior of the existing `phone-use run` command.

#### Scenario: Run mode unchanged
- **WHEN** the user runs `phone-use run <bundleId> <task>` on the new version
- **THEN** the executor, agent, and CLI produce the same behavior as before the audit feature was added, including identical prompts, action formats, and success/failure signals
