## Why

Running a thorough UX audit on a mobile app currently takes a UX researcher half a day to a full day — manually navigating screens, taking screenshots, and writing up findings. Most teams skip this step entirely, shipping UX problems that only surface through user complaints. phone-use already has all the infrastructure needed to automate this (AI-driven screen navigation, accessibility tree parsing, vision-model analysis), and recent releases of the Vercel AI SDK (`generateObject` with constrained decoding) finally make reliable structured output from vision models practical. The marginal cost to add an `audit` mode is low; the value to teams shipping mobile apps is high.

## What Changes

- Add a new `phone-use audit <bundleId>` command alongside the existing `run` command
- The AI agent systematically explores the app (not task-driven), visiting distinct screens and producing a structured UX audit report at the end
- Each visited screen is analyzed against Don Norman's design principles (Affordance, Signifier, Feedback, Mapping, Constraints) and Jakob Nielsen's mobile-priority heuristics
- Every reported issue must carry visual evidence (tied to the exact screenshot where it was found), severity, violated principle, affected persona, and an actionable recommendation
- New screen fingerprinting keeps the agent from walking in circles — visited screens are tracked and unvisited navigation targets are prioritized
- Audit output is a Markdown report with per-issue JPEG screenshots saved under `./audit-output/<run-id>/`, streamed to disk as append-only JSONL so crashes don't lose accumulated findings
- Per-step performance instrumentation (timing + token usage) with end-of-run summary and JSON export
- Action-type-based screen stability wait prevents screenshots during transitions
- Stateless per-screen analysis: no conversation history in audit mode, exploration state block is the sole memory channel
- Typed error taxonomy (`AuditError` with codes like `E_DRIVER_NOT_READY`, `E_MODEL_INCOMPATIBLE`) replaces raw stack traces
- Every step produces an annotated screenshot (tap circle + Action/Target/Why text card) so the final report is self-explanatory and the AI's reasoning is visible per issue
- Opt-in `--live` viewer streams annotated screenshots to a local browser page via SSE for real-time observability while auditing
- Proactive Gemini rate limiter (default 12 RPM, configurable via `--rpm-limit`) plus a hard 45 s per-step timeout prevents rate-limited runs from appearing hung
- Phase 1 targets iOS 26 simulator via the `xctest` runner; physical device audit is explicitly deferred to Phase 2 with a clear error message if attempted
- Unit tests for all deterministic components via Node's built-in `node:test` (zero new deps)
- `run` mode and its current behavior are untouched (zero regression)

## Capabilities

### New Capabilities
- `ux-audit`: Autonomous mobile UX audit loop — structured exploration, per-screen Norman/Nielsen analysis, evidence collection, and Markdown report generation

### Modified Capabilities
- `screen-observation`: Adds screen fingerprinting and visited-screen tracking used by the audit loop. Existing observation behavior for `run` mode is unchanged.

## Impact

- **New files**: `src/schemas/audit.ts` (Zod schema), `src/audit-agent.ts` (audit-specialized agent), `src/audit-executor.ts` (audit loop with fingerprinting, stability wait, evidence capture, JSONL streaming), `src/audit-report.ts` (Markdown report writer), `src/core/step-timing.ts` (instrumentation), `src/core/screen-fingerprint.ts` (fingerprint helper), `src/core/annotate.ts` (screenshot annotation), `src/core/jsonl-writer.ts`, `src/core/evidence.ts`, `src/core/rate-limiter.ts` (Gemini rate limiting), `src/core/live-viewer.ts` (opt-in live viewer), `src/errors/audit-errors.ts` (typed errors), `tests/*.test.ts` (unit tests), `.env.example`, `.github/workflows/test.yml`
- **Modified files**: `src/index.ts` (new `audit` subcommand + async shutdown), `src/types.ts` (new audit-related types), `src/core/tree-parser.ts` (quality grading + nav target extraction)
- **Dependencies**: No new packages — `zod`, `generateObject` from `ai` SDK, and `node:test` are already available
- **Runtime**: Audit runs reuse every existing runner (WDA / maestro / xctest); no changes to driver lifecycle. Per-device lockfile prevents concurrent audits on same device.
- **Cost**: Single API call per step, stateless (no history overhead). POC-validated ≈ $0.003 per 25-step audit on Gemini Flash (≈ 700 tokens per call, Gemini's prompt cache makes repeated system-prompt free). GPT-4o is ≈ $0.47 at the same call envelope. Token usage tracked per step with budget warning.
- **Performance budget**: ≤ 6 min wall-clock (25 steps), ≤ 12 s per-step median, ≤ 150k input tokens/run, ≤ 30 MB disk footprint
- **Risk**: UX analysis quality is the main uncertainty — mitigated by three-layer quality control (evidence-required schema fields, iOS HIG comparative anchoring, anti-pattern prompt guidance). Phase 1 ships behind manual false-positive review before public release.
