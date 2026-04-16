## 1. Types and schemas

- [x] 1.1 Add `AuditConfig`, `AuditIssue`, `AuditReport`, `VisitedScreen`, `TreeQuality`, `StepTiming`, `StepRecord` types to `src/types.ts`
- [x] 1.2 Create `src/schemas/audit.ts` with Zod schema for `AuditDecision` (navigation + optional audit block with evidence/confidence/principle/recommendation)
- [x] 1.3 Derive `AuditDecision` TS type from the Zod schema via `z.infer`

## 2. Error taxonomy

- [x] 2.1 Create `src/errors/audit-errors.ts` exporting `AuditError` class with `code: AuditErrorCode` and `hint: string`
- [x] 2.2 Define error codes: `E_DRIVER_NOT_READY`, `E_APP_NOT_INSTALLED`, `E_MODEL_INCOMPATIBLE`, `E_NETWORK_TIMEOUT`, `E_DEVICE_LOCKED`, `E_APP_CRASHED`, `E_BUDGET_EXCEEDED`, `E_USER_ABORTED`, `E_CONCURRENT_RUN`

## 3. Tree parser quality grading

- [x] 3.1 Extend `src/core/tree-parser.ts` to return `{ text: string, grade: 'rich' | 'sparse' | 'empty', labeledElementCount: number }` without breaking existing callers
- [x] 3.2 Add `extractNavTargets(tree)` helper that pulls tab bar / nav menu labels from a rich tree
- [x] 3.3 Add `extractLabels(tree)` helper that returns sorted label array for fingerprinting

## 4. Screen fingerprinting helper

- [x] 4.1 Create `src/core/screen-fingerprint.ts` exporting `fingerprintScreen({ tree, screenshot, grade })`
- [x] 4.2 Implement MD5-of-sorted-labels path for `rich` grade
- [x] 4.3 Implement perceptual-hash fallback for `sparse`/`empty` grades (simple average-hash via `sharp`)

## 5. Step timing instrumentation

- [x] 5.1 Create `src/core/step-timing.ts` exporting `StepTiming` interface, `summarize(timings)` helper (P50/P95/avg), and `estimateCost(tokens, model)` function

## 5A. Gemini rate limiter (from OPS-19 POC finding)

- [x] 5A.1 Create `src/core/rate-limiter.ts` exporting `GeminiRateLimiter` class with sliding-window token bucket (default 12 RPM = free-tier 15 RPM with 20 % headroom)
- [x] 5A.2 Implement `acquire()` that blocks when the window is full and prints a visible `⏸ Rate limit: waiting Xs (N/N)` console line so the user sees throttling is the reason for the pause
- [x] 5A.3 Implement `remaining()` helper for budget visibility
- [x] 5A.4 Expose via `AuditConfig.rpmLimit`, wired from `--rpm-limit` CLI flag (default 12; paid-tier users pass a high number to effectively disable throttling)

## 6. JSONL streaming writer

- [x] 6.1 Create `src/core/jsonl-writer.ts` exporting `appendStep(outputDir, StepRecord)` and `appendIssue(outputDir, AuditIssue)` (append-only, one line per call)
- [x] 6.2 Create `readJsonl(path)` helper for reading back records

## 7. Evidence capture with dedup

- [x] 7.1 Create `saveEvidence(outputDir, screenshotBuffer, issueId)` in `src/core/evidence.ts`
- [x] 7.2 Implement SHA-1 content hash + JPEG optimization via `sharp` (quality 85)
- [x] 7.3 Write deduplicated source file `_<hash>.jpg`, create symlink `<issueId>.jpg` → source (with copy fallback)

## 7A. Screenshot annotation

- [x] 7A.1 Create `src/core/annotate.ts` exporting `annotateScreenshot(buffer, decision, stepNum): Promise<Buffer>`
- [x] 7A.2 Build SVG overlay: red circle (outer glow r=60 + inner r=38 + dot r=14) at tap coordinate, connector line to text card, text card with `Action`, `Target:`, `Why:`, and `Step N/M · model` footer
- [x] 7A.3 Use font stack `"-apple-system, \"PingFang TC\", sans-serif"` for CJK compatibility (validated by OPS-1 POC)
- [x] 7A.4 Handle non-point actions: arrow for `scroll`/`swipe`, caret for `inputText`, no marker for `wait`/`hideKeyboard`
- [x] 7A.5 Composite overlay onto raw screenshot via `sharp.composite()` and return JPEG buffer (quality 85)
- [x] 7A.6 Add `writeAnnotated(outputDir, stepNum, annotatedBuffer)` helper that writes to `annotated/step-NN.jpg`

> **Parallelization**: Groups 2–7A are independent utility modules with no cross-dependencies. They can all be built simultaneously after Group 1 completes.

## 8. Audit CLI config

> **DAG fix**: Extracted from former Group 11 so that CLI flags (`--skip-launch`, `--max-retries`, etc.) are defined before audit agent and executor groups that depend on them.

- [x] 8.1 Add `audit` subcommand skeleton to `src/index.ts` with all flags: `--runner` (default `xctest` per Decision 20), `--device` (default booted simulator), `--language`, `--max-steps` (default 25), `--model` (default `gemini-2.5-flash`), `--scope`, `--skip-launch`, `--output-dir`, `--stable-timeout` (default 2000), `--max-retries` (default 1 — rate limiter now handles bursts), `--rpm-limit` (default 12), `--token-budget` (default 200000), `--hard-timeout` (default 45000), `--live` (flag), `--live-port` (default 7330)
- [x] 8.1a If `--runner wda` or `--ios-device` is passed with `audit`, print "physical device audit is a Phase 2 feature" and exit with non-zero status
- [x] 8.2 Build `AuditConfig` object from parsed CLI flags (so downstream groups receive typed config, not raw args)
- [x] 8.3 Print a cost warning when `--max-steps > 40`
- [x] 8.4 Reuse `getApiConfig()` and runner-selection branches from the existing `run` command to avoid drift

## 9. Audit agent

- [x] 9.1 Create `src/audit-agent.ts` exporting `AuditAgent extends TaskAgent`
- [x] 9.2 Override `decide()` as stateless: single-turn `generateObject()` with audit schema, NO conversation history
- [x] 9.3 Build the audit system prompt with Norman/Nielsen framework, iOS HIG anchoring, anti-patterns, GOOD/BAD issue examples, system-dialog handling directive, and onboarding skip guidance
- [x] 9.4 Build exploration state block with visited list (top-10 + overflow count), unvisited targets, last 3 actions, phase, and tree grade
- [x] 9.5 Set `maxRetries` from `AuditConfig.maxRetries` on the AI SDK call (default 1 in audit mode; rate limiter handles bursts)
- [x] 9.6 Call `rateLimiter.acquire()` before every `generateObject` call
- [x] 9.7 Wrap `generateObject` in `Promise.race` against a hard per-step timeout (default 45 s from `AuditConfig.hardTimeout`); on timeout throw `AuditError('E_NETWORK_TIMEOUT', ...)`
- [x] 9.8 Wrap `generateObject` in try/catch; on `NoObjectGeneratedError` fall back to `generateText()` navigation-only prompt; track `fallbackStreak` and throw `E_MODEL_INCOMPATIBLE` at 3 consecutive
- [x] 9.9 Tighten Zod schema descriptions per OPS-2 POC findings: `progress` as `z.number().int().min(0).max(100)` with `.describe('integer 0-100 where 100 = audit goal reached')`; `x`/`y` as `z.number().int().min(0).max(100).optional()` with `.describe('percentage; ONLY use when text unavailable')`
- [x] 9.10 Drop issues with `confidence < 60` before returning the decision
- [x] 9.11 Tag steps where onboarding was detected as `onboarding: true`

## 10. Audit executor — scaffold and lifecycle

> **Split note**: Former monolithic Group 9 (13 tasks) split into Groups 10–12 per review recommendation.

- [x] 10.1 Create `src/audit-executor.ts` exporting `AuditExecutor extends TaskExecutor`
- [x] 10.2 Override `execute()` to run the audit loop while reusing the parent's driver lifecycle and action execution
- [x] 10.3 Acquire per-device lockfile on start (`/tmp/phone-use-audit-<device-id>.lock`), throw `E_CONCURRENT_RUN` if already locked; clean up on exit via `process.on('exit')`
- [x] 10.4 Create output directory `./audit-output/<timestamp>-<bundleId>/` with `screenshots/` subdirectory
- [x] 10.5 Honor `AuditConfig.skipLaunch` by skipping the parent's `launch()` call

## 11. Audit executor — exploration and stability

- [x] 11.1 Maintain `visitedScreens: Map<string, VisitedScreen>` and update after every step using the fingerprint helper
- [x] 11.2 Maintain `unvisitedTargets: string[]` using `extractNavTargets()` on rich-tree screens
- [x] 11.3 Implement action-type-based stability wait: `NAVIGATION_ACTIONS` set → `waitForScreenStable(config.stableTimeout, 250)`, others → `getPostActionDelay()`

## 12. Audit executor — persistence, evidence, timing, and reliability

- [x] 12.1 Integrate JSONL streaming: call `appendStep` after each step, `appendIssue` for each issue
- [x] 12.2 Integrate evidence capture: call `saveEvidence` for each issue before executing navigation action
- [x] 12.3 Integrate annotation: call `annotateScreenshot` + `writeAnnotated` for every step (always on, not gated by `--live`)
- [x] 12.4 Integrate timing: wrap each segment with `performance.now()`, capture `response.usage`, push to `StepTiming[]`
- [x] 12.5 Write `timings.json` to output directory on finalize
- [x] 12.6 Print P50/P95/avg summary + cost estimate to console on completion
- [x] 12.7 Implement screenshot retry with exponential backoff (1s/2s/3s) and driver-liveness check; throw `E_DEVICE_LOCKED` or `E_DRIVER_NOT_READY` at 3 consecutive failures
- [x] 12.8 Detect app-crash condition (bundle no longer in foreground for 2 consecutive steps) and throw `E_APP_CRASHED`

## 13. Report writer

- [x] 13.1 Create `src/audit-report.ts` exporting `finalizeReport(outputDir)` which reads JSONL and renders Markdown
- [x] 13.2 Render header block (app, device, iOS version, runner, model, date, duration, step count with onboarding-excluded, coverage, cost estimate)
- [x] 13.3 Render severity summary table (High / Medium / Low counts) and one-line top-concern pointer
- [x] 13.4 Render each issue section: ID, severity, title, screen, principle(s), persona(s), confidence, step #, embedded annotated image, evidence (AI observation), AI reasoning, recommendation, and a "how to verify the fix" re-audit command
- [x] 13.5 Embed annotated screenshots (`annotated/step-NN.jpg`) in issue sections, NOT raw screenshots
- [x] 13.6 Render screen map as indented tree in discovery order; list onboarding screens separately as not counted
- [x] 13.7 Render performance summary table (P50 / P95 / avg per segment) and token cost
- [x] 13.8 Render "Next steps" section prioritizing High-severity fixes, offering scoped re-audit commands
- [x] 13.9 Render partial-report banner with `AuditError` code when run ended early
- [x] 13.10 Exclude onboarding-tagged steps from coverage summary

## 14. CLI wiring (final integration)

- [x] 14.1 Wire `AuditExecutor` + `AuditAgent` into the `audit` subcommand action handler from Group 8
- [x] 14.2 Convert signal handlers to async to call `finalizeReport()` before exit
- [x] 14.3 Add CLI-level `AuditError` formatter: print code + hint + doc link for `AuditError`, raw stack for unknown errors
- [x] 14.4 Exit with code 0 on successful audit completion (even if issues were found) and code 1 only on hard failure

## 14A. Live viewer (opt-in)

- [x] 14A.1 Create `src/core/live-viewer.ts` that starts a local HTTP server on `--live-port` (default 7330)
- [x] 14A.2 Serve a single-file HTML page with main panel + thumbnail strip layout
- [x] 14A.3 Implement SSE endpoint that pushes each annotated screenshot as it is written
- [x] 14A.4 Auto-open the viewer URL in the default browser via `open` on macOS when `--live` is passed
- [x] 14A.5 Gracefully shut down the server on audit completion, error, or SIGINT
- [x] 14A.6 Wire `--live` / `--live-port` flags through `AuditConfig`; if `--live` is absent, skip server startup entirely (zero overhead)

## 15. Unit tests

- [x] 15.1 Set up `npm test` script: `node --test tests/**/*.test.ts`
- [x] 15.2 Test `screen-fingerprint.ts`: stability (same input → same output), sort invariance, sparse/empty fallback, 8-char hex format
- [x] 15.3 Test `tree-parser.ts` grading: boundary cases at 0, 1, 2, 9, 10 elements
- [x] 15.4 Test `schemas/audit.ts`: valid schema acceptance, evidence min(20) rejection, confidence range, optional audit block absence
- [x] 15.5 Test `audit-report.ts`: full report render, empty issues, partial-run banner, onboarding exclusion
- [x] 15.6 Test `step-timing.ts`: P50/P95/avg math with known inputs, cost estimation per model
- [x] 15.7 Test `jsonl-writer.ts`: write and read-back round-trip, empty file handling
- [x] 15.8 Test `evidence.ts`: hash dedup (2 identical buffers → 1 file), symlink creation
- [x] 15.9 Test `annotate.ts`: SVG overlay renders for tap/scroll/swipe/inputText, output buffer is valid JPEG, text card contains Action/Target/Why

## 16. Run-mode regression safety

- [x] 16.1 Verify `src/agent.ts` and `src/executor.ts` are unchanged where they serve the `run` command
- [x] 16.2 Run an end-to-end `phone-use run` flow on a simulator and confirm identical behavior to the previous release
- [x] 16.3 Run `npx tsc --noEmit` on the full project and fix any type errors introduced by the new files

## 17. Quality gate and dogfood

> **Phase 1 scope (Decision 20)**: iOS 26 simulator only. Physical device deferred to Phase 2.

- [x] 17.1 Run `phone-use audit com.apple.Preferences --runner xctest --max-steps 25 --live` on the booted iOS 26 simulator (rich tree target from Decision 21)
- [x] 17.2 Run `phone-use audit com.apple.Maps --runner xctest --max-steps 20` (sparse tree target)
- [x] 17.3 Run `phone-use audit com.apple.mobilesafari --runner xctest --max-steps 15` (empty / WebView target)
- [x] 17.4 Manually review every issue in the three generated reports; compute false-positive rate
- [x] 17.5 If false-positive rate ≥ 20 %, iterate on the anti-patterns and anchoring prompt sections, re-run, and re-measure before merging
- [x] 17.6 Confirm coverage target: at least 8 distinct fingerprints in the 25-step Settings run
- [x] 17.7 Confirm `generateObject` parse success rate ≥ 98 % across the three runs
- [x] 17.8 Confirm performance budget: per-step median ≤ 12s, total ≤ 6 min, disk ≤ 30 MB
- [x] 17.9 Confirm timing + token data exports correctly to `timings.json`
- [x] 17.10 Confirm rate limiter triggers at least once during the Settings run on free-tier Gemini and that the `⏸ Rate limit: waiting Xs` message appears — N/A: paid tier runs at 10 RPM and AI calls take ~7s each (~8 RPM effective), so the limiter never fires. Unit tests (20.1) cover the sliding-window logic. Free-tier daily quota exhaustion is documented in handoff §5A.

## 18. Documentation

- [x] 18.1 Update `CLAUDE.md` with a short "audit mode" section, the `when to use which` table comparing `run`, `audit`, and `phone-explore`, and a **Known limitations** paragraph noting iOS 26 physical device is Phase 2
- [x] 18.2 Add a README snippet showing a minimal `phone-use audit` invocation and the resulting report layout
- [x] 18.3 Document the `--skip-launch` pre-auth workflow with a concrete LINE example
- [x] 18.4 Create `docs/audit-errors.md` with troubleshooting for each `AuditErrorCode`
- [x] 18.5 Add `audit-output/` to `.gitignore` with a comment about PII in screenshots

## 19. Operational readiness (from OPS pre-mortem)

- [x] 19.1 Add `.env.example` with `GOOGLE_GENERATIVE_AI_API_KEY=your-key-here` and commented `OPENAI_API_KEY=`; update README to point at it (OPS-5)
- [x] 19.2 Add `engines.node` in `package.json` to `>=18.0.0 <26` and run `npm test` + `npx tsc --noEmit` on Node 18 / 20 / 22 to verify `node:test` compatibility (OPS-6)
- [x] 19.3 Add `.github/workflows/test.yml` running `npx tsc --noEmit` and `npm test` on `macos-latest` across a Node 18 / 20 / 22 matrix (OPS-7)
- [x] 19.4 Resolve `AuditConfig.outputDir` via `path.resolve(process.cwd(), ...)` and document "outputs land in the current working directory" in README (OPS-8)

## 20. Unit tests for rate limiter (from OPS-19)

- [x] 20.1 Test `rate-limiter.ts`: single call within budget returns immediately, N+1 call blocks, timestamps outside window are pruned, `remaining()` returns correct count

## Sprint 1 — Report Quality (Phase 2)

### Core fixes (all done)
- [x] S1.C1 Inject real frame dimensions (W×Hpt) into accessibility tree output
- [x] S1.C2 Add `cognitiveImpact` field to schema + GOOD/BAD examples in prompt
- [x] S1.C3 Scope guard: detect cross-app drift via `extractAppIdentifier()` and auto-back

### High-priority fixes (all done)
- [x] S1.H1 Fuzzy dedup with Jaccard bigram similarity + cross-screen principle dedup
- [x] S1.H2 Anti-patterns: modal sheets, chrome, pull-to-refresh, back button labels, font specimens
- [x] S1.H3 Severity calibration rubric with measurement thresholds

### Post-dogfood fixes
- [x] S1.P1 Font specimen false positives: CONTEXT FILTER + BAD example + code post-filter
- [x] S1.P3 Paginated content stuck: consecutive swipe escape (MAX_CONSECUTIVE_SWIPES=4)
- [x] S1.P4 Subtree escape: stuck escape → relaunch app instead of back
- [x] S1.P5 Step budget estimation: parse home screen tree, count sections, display coverage estimate
- [x] S1.V1 Final dogfood verification: clean simulator, 25-step Settings audit
