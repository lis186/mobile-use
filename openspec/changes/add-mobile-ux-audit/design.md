## Context

phone-use today runs a task-driven loop: user gives a task, agent observes → decides → acts until `done`. Everything is already in place for a second, exploration-driven mode that piggybacks on the same loop but changes what the agent is asked to produce. The three prior-art influences are: Vercel's agent-browser `dogfood` skill (systematic exploration + per-finding evidence), the user's existing `ux-heuristic-analysis` Claude skill (Norman/Nielsen framework), and phone-use's own `phone-explore` skill (screen inventory without audit).

A full pre-mortem (see `/Users/justinlee/.claude-switch/accounts/work/plans/groovy-marinating-pearl.md`) identified 13 failure modes across CRITICAL / HIGH / MEDIUM / LOW severity. Every CRITICAL and HIGH mode was scored against a weighted rubric and required a design with a score ≥ 9.0 / 10 before being accepted. The decisions below are those winning designs.

Stakeholders: solo/small-team mobile devs who want automated UX review before each release; future CI/CD integration; the existing `phone-explore` user base (overlaps but differentiated).

Constraints:
- Must reuse existing executor loop, runner backends (WDA / maestro / xctest), and tree parser — no forking of the main loop
- Must not regress `run` mode
- No new external dependencies (`zod` and `ai` SDK's `generateObject` are already installed)
- Budget: ~480 LOC across 4 new files and 2 modified files
- Cost target: ≤ $0.5 per 25-step audit on Gemini Flash

## Goals / Non-Goals

**Goals:**
- Reliable structured output from vision models (>98% parse success)
- Systematic exploration (≥8 distinct screens in 25 steps)
- Per-issue evidence that is time-aligned with the screen where the issue was found
- False-positive rate <20% (validated by manual review in Phase 1 gating)
- Zero changes to `run` mode behavior

**Non-Goals:**
- Diff audits across releases (Phase 2)
- Team-specific report formats (Jira/Linear/TestRail exporters — Phase 2)
- Android support (out of scope for Phase 1; follows existing platform scope)
- Auto-login / credential handling (use pre-authenticated state via `--skip-launch`)
- A brand-new agent framework — this extends the existing `TaskAgent`, not replaces it
- Cross-app flows in a single audit run (one `bundleId` per audit)

## Decisions

### Decision 1: Use `generateObject()` + Zod schema for audit output

**Context:** The audit agent has to return navigation decision + screen metadata + a list of issues in one call. Free-form `generateText()` + regex JSON parsing degrades fast at this shape — vision models truncate, hallucinate keys, and emit stray markdown fences.

**Alternatives considered:**
- A: Two-pass split (nav first, then a separate audit call). Scored 8.75 — token cost doubles.
- B: `generateObject()` + Zod schema. Scored **9.75** — single call, constrained decoding guarantees valid JSON.
- C: Layered JSON (simple nav + optional audit field with regex parse). Scored 8.25 — audit field stays fragile.
- D: Navigation-first with an audit sidecar on a cheaper model. Scored 9.0 — clean but still 2× calls.

**Decision:** Use B. Audit-specific fields are declared `.optional()` in the schema so the model can skip them when the screen has nothing worth reporting, giving natural graceful degradation. On total `NoObjectGeneratedError`, fall back to `generateText()` with a navigation-only prompt so the step is never wasted.

### Decision 2: Three-layer quality control for UX analysis

**Context:** Naive prompting of a vision model with "apply Norman/Nielsen" produces formulaic, high-false-positive output ("this button lacks affordance" on perfectly affordant buttons). Quality control must be zero extra API calls.

**Alternatives considered:**
- A: Confidence-gated reporting. Scored 4.0 — models are badly calibrated.
- B: Evidence-required schema field only. Scored 7.75 — good floor but model can fabricate specific-sounding evidence.
- C: Comparative anchoring only. Scored 8.25 — good but needs a reference library.
- D: Two-stage verification (2× API). Scored 8.0 — cost doubles.
- E: Prompt-only anti-patterns. Scored 8.125 — fragile across models.
- F: Hybrid (B + C + E). Scored **9.25**.

**Decision:** Use F. Three compounding layers catch different failure modes:
1. **Evidence-required** (schema): every issue must have `evidence: z.string().min(20)` describing concrete visual facts
2. **Comparative anchoring** (prompt): explicit iOS HIG reference points (44×44pt tap targets, 4.5:1 contrast, 11pt minimum text)
3. **Anti-patterns** (prompt): explicit list of non-issues ("standard tab bar is NOT confusing navigation") with good/bad issue examples

Each issue also carries a self-reported `confidence: z.number().min(0).max(100)`. Issues below 60 are dropped post-parse — this is the free tiebreaker when all three layers leave a borderline case through.

### Decision 3: Screen fingerprint + visited-map + nav-target extraction for exploration

**Context:** Without explicit state, the agent revisits the same 3–4 screens in a 25-step run. agent-browser solves this with its snapshot-ref model, but phone-use only has the accessibility tree (and that's not always rich).

**Alternatives considered:**
- A: Screen fingerprinting only. Scored 7.625.
- B: Tree-driven explicit navigation queue. Scored 7.875 — breaks when tree is sparse.
- C: Budget allocation phases only. Scored 6.75 — no actual dedup.
- D: Tree-diff novelty signal only. Scored 7.75.
- E: Hybrid (A + B + D, simplified). Scored **9.25**.

**Decision:** Use E. Three pieces of state maintained by the executor and injected into each prompt:
1. **Screen fingerprint**: MD5 of sorted accessibility-tree labels. When tree is sparse, fall back to a perceptual hash of the screenshot. First 8 hex chars used as key.
2. **Visited map** (`Map<fingerprint, { name, count, issuesFound }>`): updated after every step.
3. **Nav target extraction**: on the first rich-tree screen, pull labels of tab bar / menu / primary nav elements into an `unvisitedTargets: string[]` that the agent is told to prefer.

The executor prepends a small, structured "EXPLORATION STATE" block to the user message each step:

```
EXPLORATION STATE:
- Visited: Home (2x), Settings (1x) — 2 unique screens, 18 steps remaining
- Unvisited nav targets from tree: [Profile, Notifications, Help]
- Phase: exploration (6/20) — visit unvisited areas FIRST
```

No explicit queue — the agent decides next action freely, it just has the state it needs.

### Decision 4: Evidence collection is synchronous with the step that discovered the issue

**Context:** `dogfood`'s hard rule is "record the finding before you move on." In phone-use the loop already works this way: the screenshot in a given step is the exact screen the agent is analyzing, so no separate "go back and screenshot" round trip is needed.

**Decision:** Immediately after a successful `generateObject()` call, iterate `decision.audit?.issues`, and for every issue, copy the current step's PNG buffer to `${outputDir}/screenshots/${issueId}.png`. The issue references that filename in the report. Zero extra latency. Multiple issues from the same step share nothing — each gets its own copy to keep the report portable.

### Decision 5: Tree quality grading with tri-state fallback

**Context:** Accessibility tree quality varies wildly (native UIKit apps are rich; WebViews, games, and custom Canvas-based UIs are nearly empty). Every decision above must degrade gracefully.

**Decision:** Introduce a three-tier grading in `tree-parser.ts`:
- `rich` (≥10 labeled elements): tree drives fingerprint + nav targets + informs analysis
- `sparse` (2–9): tree still helps fingerprint but is not used for nav planning
- `empty` (<2): perceptual hash of screenshot is the fingerprint; agent runs in visual-only mode

The grade is injected into the prompt so the model knows what it can trust:

```
ACCESSIBILITY DATA: sparse
- Rely primarily on visual analysis. Tree labels are unreliable on this screen.
```

### Decision 6: Subclass, don't fork — `AuditAgent extends TaskAgent`, `AuditExecutor extends TaskExecutor`

**Context:** The `run` loop is battle-tested and both modes share 90% of the mechanics (spinners, runner lifecycle, action execution, stuck detection).

**Decision:** Extend, override the narrow hot spots:
- `AuditAgent.decide()` overrides the parent's `decide()` to use `generateObject()` with the audit schema and to build a different system prompt
- `AuditExecutor.execute()` overrides the loop body to add fingerprinting, visited-state injection, evidence capture, and report writing
- Action execution (`executeAction`), driver lifecycle, and error handling are inherited unchanged

This guarantees `run` mode behavior cannot regress from `audit` work and keeps the line-count budget realistic (~480 LOC added).

### Decision 7: System dialog handling is a prompt directive, not special-case code

**Context:** iOS system alerts (permission prompts, Face ID, "Rate this app") can stall an audit mid-run. Writing detection code for every variant is a losing game.

**Decision:** Add explicit prompt text: *"If you see an iOS system dialog (permissions, Face ID, app rating, etc.), tap the most permissive safe action (Allow / OK / Later) to dismiss it. Do NOT report system dialogs as UX issues."* Vision models are already very reliable at recognizing iOS dialogs. Zero code.

### Decision 8: Auth is handled by `--skip-launch`, not by credential flags

**Context:** Many apps hit a login wall on launch. Shipping credential flags invites security foot-guns (passwords in process args / history).

**Decision:** Ship `--skip-launch` on the audit command. The user manually logs in once (via `phone-use run` or direct interaction), then runs `phone-use audit <bundleId> --skip-launch` which attaches to the foreground state without relaunching the app. No credential material ever touches phone-use.

### Decision 9: Per-step performance instrumentation with token usage

**Context:** The Phase 1 acceptance criteria (cost, coverage, wall-clock) have no baseline to compare against. We need objective numbers from the first dogfood runs, not console logs that scroll past.

**Decision:** Add a small `src/core/step-timing.ts` helper that records `{ step, screenshot_ms, tree_ms, ai_ms, action_ms, sleep_ms, total_ms, input_tokens, output_tokens }` per step using `performance.now()` and the `usage` object returned by `generateObject()` / `generateText()`. The executor pushes one record per step into an in-memory array and writes it to `./audit-output/<run-id>/timings.json` on finalize, along with a P50/P95/avg summary printed to console. Activation is gated by `PHONE_USE_TIMINGS=1` for `run` mode (opt-in, zero default overhead) and always-on in `audit` mode (acceptance data matters there). `performance.now()` is sub-microsecond; the overhead is invisible.

**Alternatives considered:** `AsyncLocalStorage` middleware (too abstract, >120 LOC), `node:perf_hooks` PerformanceObserver (verbose setup), extending the existing spinner (incomplete — action execution has no spinner). Plain `performance.now()` scored 10.0 / 10 on the rubric.

### Decision 10: Action-type-based stability wait in audit mode

**Context:** `run` mode relies on a short fixed sleep after each action. In `audit` mode the next screenshot is analyzed far more critically — if it lands during a slide transition or fade, the agent either reports bogus "visual glitches" or wastes the step. Always waiting is too expensive; never waiting is too noisy.

**Decision:** `AuditExecutor` maintains a `NAVIGATION_ACTIONS` set (`tap`, `tapText`, `back`, `launchApp`, `openLink`, `pressKey`, `doubleTap`). After any action in that set it calls the existing `waitForScreenStable(maxMs = 2000, intervalMs = 250)` — a shorter, tighter-polling variant of the launch-time wait. Non-navigation actions (`scroll`, `swipe`, `inputText`, `hideKeyboard`, `wait`) keep the original `getPostActionDelay()`. A CLI flag `--stable-timeout <ms>` lets users override the 2 s ceiling. `run` mode is untouched.

**Alternatives considered:** always wait (scored 6.8 — too slow), universal shortened wait (scored 8.1 — over-applies to scroll/input), tree-diff adaptive (scored 7.5 — fails on sparse trees). Action-classification hybrid scored 9.15.

### Decision 11: Stateless audit mode — the exploration state block IS the memory

**Context:** `TaskAgent` carries a conversation history with the last 2 screenshots. That's the right design for a task loop where the agent needs to remember past attempts. In `audit` mode every screen is analyzed independently; previous screenshots waste input tokens and can bias the current analysis ("I already reported a contrast issue, so this one must be fine").

**Decision:** `AuditAgent.decide()` does NOT use `this.conversationHistory`. Each call is a single-turn message: system prompt + current screenshot + tree block + exploration state block. The exploration state block (from Decision 3) is extended with a `Last 3 actions:` line so the agent still knows where it came from, but all memory is explicit, structured, and bounded. Expected effect: ~30 % fewer input tokens per step, ~20 % lower prefill latency, cleaner per-screen analysis. `run` mode and `TaskAgent` history behavior are completely untouched — `AuditAgent extends TaskAgent` and overrides only `decide()`.

**Alternatives considered:** full stateless with no state block (scored 9.25 — loses exploration continuity), text-only summary history (scored 8.35), last-N text-only (scored 6.6), previous-screenshot comparison (scored 7.2). The "state block IS the memory" hybrid scored a perfect 10.0.

### Decision 12: Append-only JSONL for streaming writes and reasoning persistence

**Context:** Writing `report.md` only at the end means a crash on step 20 of a 25-step run loses 19 steps of findings. The AI's `reasoning` field currently goes to console only — useless for post-mortem analysis of why the audit made a bad call.

**Decision:** Every step writes one JSONL line to `./audit-output/<run-id>/steps.jsonl` (`{ step, fingerprint, action, reasoning, issues_found, screen_name, timing }`) and one line per issue to `issues.jsonl`. On normal finish, on crash, or on SIGINT, a shared `finalizeReport()` function reads both JSONL files and renders `report.md`. Partial reports are explicitly marked at the top. The `src/index.ts` signal handlers are converted to async to allow `finalizeReport()` to run before exit. Disk overhead: one `fs.appendFile` per step (<1 ms, irrelevant next to the multi-second AI call).

**Alternatives considered:** write whole report every step (wasteful), in-memory buffer flushed on interval (still lossy on SIGKILL). JSONL scored 9.5 across persistence / recoverability / complexity.

### Decision 13: Content-hash evidence dedup + JPEG optimization + symlinks

**Context:** Saving one PNG per issue explodes disk when a step produces multiple issues from the same screenshot. A real 25-step run with an average of 1.5 issues per step means ~38 PNG files, each 500 KB – 2 MB, for 20–75 MB total — and many of them are literally identical bytes.

**Decision:** `saveEvidence()` hashes the screenshot buffer (SHA-1, first 12 chars), writes one optimized JPEG (`sharp`, quality 85) to `screenshots/_<hash>.jpg` if it doesn't exist, and creates `screenshots/<issueId>.jpg` as a symlink to it. On filesystems that reject symlinks (rare on macOS / Linux), the code falls back to `fs.copyFile`. Net footprint on a typical 25-step run drops from ~50 MB to <5 MB. The report references `screenshots/<issueId>.jpg` — the symlink is transparent to any markdown renderer.

**Alternatives considered:** copy every PNG (spec's original stance — portable but wasteful), single shared file + in-text references (breaks report portability). Hash-plus-symlink scored 9.05.

### Decision 14: Fallback retry budget and device-level error classification

**Context:** The `generateObject` → `generateText` fallback from Decision 1 has no streak limit. A misconfigured model could silently run the entire audit through the degraded path, producing nav-only output with no UX findings. Separately, screenshot failures today just sleep 2 s and retry forever — a crashed WDA or a sleeping device looks the same as a transient glitch.

**Decision:** Two small streak counters in `AuditExecutor`:
1. `fallbackStreak` — incremented on `NoObjectGeneratedError`, reset on success. At 3 consecutive fallbacks, throw `AuditError('E_MODEL_INCOMPATIBLE', …)` with a hint to switch models.
2. `screenshotRetries` — at 3 consecutive screenshot failures, call `isDriverAlive()`. If alive, throw `AuditError('E_DEVICE_LOCKED', …)`. If dead, throw `AuditError('E_DRIVER_NOT_READY', …)`. Between retries the executor backs off linearly (1 s / 2 s / 3 s).

Classification makes the difference between "try again" and "restart everything" obvious to the user and to the partial report footer.

### Decision 15: Typed error taxonomy via `AuditError`

**Context:** Today any failure in the audit loop surfaces as a raw JavaScript stack trace. Users don't know whether the problem is the device, the model, the network, or their own config.

**Decision:** Introduce `src/errors/audit-errors.ts` exporting an `AuditError` class with a discriminated `code` field and a `hint` string. Codes include: `E_DRIVER_NOT_READY`, `E_APP_NOT_INSTALLED`, `E_MODEL_INCOMPATIBLE`, `E_NETWORK_TIMEOUT`, `E_DEVICE_LOCKED`, `E_APP_CRASHED`, `E_BUDGET_EXCEEDED`, `E_USER_ABORTED`. The CLI's top-level catch formats these consistently and points to a short `docs/audit-errors.md` troubleshooting page. Unknown errors still dump a stack trace so we don't hide bugs.

### Decision 16: Unit tests via Node's built-in `node:test`

**Context:** phone-use has zero tests today. Introducing `vitest` or `jest` adds 20+ MB to `node_modules` and new config surface. But the new audit components — screen fingerprinting, tree quality grading, Zod schema validation, markdown report rendering, timing statistics — are all deterministic and easy to unit-test.

**Decision:** Use Node 18's built-in `node:test` and `node:assert`. No new dependencies. Tests live under `tests/` and run via `npm test` → `node --test tests/**/*.test.ts`. Phase 1 targets: fingerprint stability + sort invariance + sparse fallback, tree grading at 0/1/2/9/10 element boundaries, Zod schema accept/reject matrix (evidence min length, confidence bounds, optional-field absence), report renderer with empty issues and partial-run markers, timing `summarize()` percentile math. Total ≈ 300 LOC of tests, runs in under 2 seconds, no device required, drops straight into CI.

**Alternatives considered:** `vitest` (9.5 — great DX, but new dep), record-and-replay E2E (5.9 — fragile), snapshot-only (7.4 — too shallow). `node:test` scored 9.625.

### Decision 18: Observable actions via annotated screenshots + opt-in live viewer

**Context:** `XCTest` programmatic taps bypass UIKit's touch pipeline, so iOS does not render any visible indicator where the AI tapped. The user watching the device sees *consequences* (screens change) but not *causes* (where the finger landed and why). A wide Gulf of Evaluation (Norman) makes every failure ambiguous: was the coordinate wrong, the target misidentified, or the app in an unexpected state? Worse — without visible feedback, the final audit report devolves into opaque screenshots that require the reviewer to reconstruct the AI's intent from text alone.

A three-expert analysis (Bret Victor / Jonathan Lipps / Don Norman simulation) converged on:
- iOS permission model makes on-device overlay physically impossible (no `SYSTEM_ALERT_WINDOW` equivalent)
- The right answer is to annotate at the consumption side, not the device side
- Annotation must carry four information layers: *what the AI saw*, *what the AI thought the target was*, *what the AI did*, *why*

**Decision:** Three-tier observability:

**L1 — Annotated screenshots (always on, essentially free):**
- `src/core/annotate.ts` exports `annotateScreenshot(buffer, decision, stepNum) → Buffer`
- Uses `sharp.composite()` with an SVG overlay containing a red pulsing circle at the tap coordinate, a connector line, and a text card showing `Action`, `Target`, `Why` (first sentence of reasoning)
- Saved to `audit-output/<run>/annotated/step-NN.jpg`
- `saveEvidence()` references the annotated version in the report, not the raw screenshot — so the final Markdown makes every issue self-explanatory without cross-referencing
- Raw screenshot still saved once (content-hash dedup from Decision 13) for fidelity

**L2 — Live viewer (opt-in via `--live`):**
- `src/core/live-viewer.ts` spawns a local HTTP server on port 7330 (configurable)
- Serves a single HTML page with an SSE stream of annotated screenshots
- Layout: main panel shows the current step in full detail; right rail is a thumbnail strip of the last 5 steps
- Auto-opens in the user's default browser via `open` (macOS)
- Opt-in because the server, SSE push, and browser rendering add ~200-500 ms of per-step overhead

**L3 — Video export (Phase 2):** ffmpeg composition of annotated frames into a webm — deferred.

**Rejected alternatives:**
- On-device overlay via ReplayKit broadcast extension — requires a signed iOS app, disproportionate to the tool's scope
- Fork of WebDriverAgent with tap visualization — maintenance burden, cross-runner incompatibility
- Second physical device mirroring via AirPlay — not automatable
- Post-run annotation only (no live view) — violates Victor's zero-latency feedback principle for developers actively iterating

**Why this is Phase 1 and not Phase 2:** Without annotated screenshots, the audit report is a list of claims the reviewer has to take on faith. The reviewer can't tell a correct-target / wrong-app-state bug from a wrong-target / wrong-coordinate bug. That distinction changes who fixes the issue (product vs engineering) and how. Shipping without L1 would make the whole feature feel untrustworthy on first contact.

### Decision 17: Safeguards, defaults, and prompt guidance grab-bag

Smaller concerns that share a common theme — "sensible defaults that prevent one-off pain" — handled together:

- **Per-device lockfile** (PM-22): `AuditExecutor` writes `/tmp/phone-use-audit-<udid>.lock` with its PID on start, checks on start, and cleans up on exit. A second audit on the same device while one is running raises `AuditError('E_CONCURRENT_RUN', …)`. No cross-device interference.
- **State block top-K truncation** (PM-24): the visited-screen line in the exploration state block is capped at 10 entries (by visit count descending) with a trailing `... +N more` to keep the prompt bounded even on deep apps.
- **Default model**: `gemini-2.5-flash`. Lowest cost per run (≈ $0.015 for Gemini vs ≈ $0.47 for GPT-4o at the same token envelope), supports structured output with vision, already the recommended `.env` entry.
- **maxRetries**: audit agent sets `maxRetries: 3` on the AI SDK call (SDK default is 2). A single transient failure shouldn't waste a step. Exposed via `--max-retries`.
- **Onboarding guidance** (PM-29): the audit system prompt includes a paragraph telling the agent to skip onboarding / tutorial / "what's new" screens via Skip/Got it/Continue without counting them as audit coverage. Steps spent on onboarding are tagged in `steps.jsonl` as `onboarding: true` and excluded from the coverage summary.
- **PII awareness** (PM-23): the default output path `./audit-output/` is added to the project's `.gitignore` template; the README explicitly warns that audit reports contain screenshots that may include personal data from logged-in state; a future `--redact` flag is noted as Phase 2.

### Decision 19: Proactive Gemini rate limiting with hard per-step timeout

**Context:** Real-environment POC (OPS-2) revealed that Gemini 2.5 Flash free tier hits rate limits during sustained audit runs. The AI SDK's default `maxRetries: 3` with exponential backoff turns a single rate-limited call into a **240 s** wall-clock wait, making a 25-step audit appear hung for over an hour. This failure mode was invisible during design.

**Decision:** Introduce `src/core/rate-limiter.ts` with a simple sliding-window token bucket:
- Default `rpmLimit = 12` (20 % headroom under free-tier 15 RPM)
- Tracks call timestamps within a 60 s window
- `acquire()` blocks until capacity is available and prints a visible `⏸ Rate limit: waiting Xs` message so the user knows why the run stalled
- Configurable via `--rpm-limit <n>` — paid-tier users set a high value and effectively disable throttling

Combined with a **hard per-step timeout** of 45 s (wraps the `generateObject` call in `Promise.race`), the worst case per step is bounded:

| Tier | Rate limiter | maxRetries | Worst case per step |
|------|--------------|------------|---------------------|
| free-tier Gemini | 12 RPM | 1 | ~5 s throttle + 8 s call = 13 s |
| paid-tier Gemini | 1000 RPM | 3 | 45 s (hard timeout) |
| non-Gemini | pass-through | 3 | 45 s (hard timeout) |

Also drops `maxRetries` in audit mode from 3 to 1, since the rate limiter now prevents the failure mode that retries were defending against.

**Alternatives rejected:** upgrade-only (requires user action, zero grace), fallback model chain (doubles API surface), static exponential backoff without throttling (still hits 503s during bursts). Scored 9.5.

### Decision 20: Phase 1 targets iOS 26 simulator only; physical device deferred

**Context:** Operational pre-mortem surfaced that this machine's physical iPhone is on iOS 26.3.1. WebDriverAgent has historically only worked up through iOS 17-18, and no documented Phase 1 runner targets iOS 26 on device (`xctest.ts` hard-codes `platform=iOS Simulator`). Meanwhile, iOS 26 simulator + macOS 26 Tahoe + Xcode 26.3 is exactly the environment the existing xctest runner was built for — `xctest.ts` opens with a comment explaining it exists because "Maestro CLI hangs on macOS Tahoe 26.x".

**Decision:** Phase 1 dogfood runs exclusively on iOS 26 simulator via the `xctest` runner. Tasks 17.x are worded as "on an iOS 26 simulator", not "on a real device". CLAUDE.md gains a **Known Limitations** section explicitly stating iOS 26 physical-device support is out of scope for Phase 1 and parked as a Phase 2 research task.

This reframes OPS-3 (WDA build cache prep) as **moot for Phase 1** — WDA is not on the Phase 1 critical path. The Xcode Accounts / signing issue discovered during OPS-3 investigation is documented but not a blocker.

### Decision 21: Phase 1 test app triad — Settings / Maps / Safari

**Context:** Phase 1 dogfood needs three apps covering the three accessibility-tree quality tiers (rich / sparse / empty), with zero PII risk, zero ToS risk, and reproducibility on any Mac with Xcode.

**Decision:** Phase 1 locks in three Apple built-in apps on the iOS 26 simulator:

| # | Bundle ID | Purpose | Tree grade |
|---|-----------|---------|------------|
| 1 | `com.apple.Preferences` | Validates rich-tree nav extraction + visited map | rich (every row has a label, clear hierarchy) |
| 2 | `com.apple.Maps` | Validates sparse-tree perceptual-hash fallback | sparse (map canvas is custom drawing) |
| 3 | `com.apple.mobilesafari` | Validates visual-only mode and degraded path | empty / WebView |

All three are Apple-owned, pre-installed on any iOS simulator, contain zero user data on a fresh sim, and have well-understood UI for reviewers to sanity-check false positives against. Settings in particular exercises nav-target extraction because its sidebar is a literal list of labeled navigation destinations.

## Risks / Trade-offs

- **UX analysis false positives above 20%** → Three-layer quality control (Decision 2). Phase 1 gates public release on manual review of the first 10 reports. If FP stays above 20%, iterate on the anti-patterns list before widening availability.
- **Sparse accessibility trees break nav-target extraction** → Tri-state grading (Decision 5). When `sparse` or `empty`, exploration falls back to perceptual-hash deduplication — still better than today's zero planning.
- **`generateObject` not supported by all models with vision input** → Documented model allowlist (Gemini 2.5 Flash, GPT-4o). On `NoObjectGeneratedError`, automatic fallback to `generateText()` with a navigation-only prompt so the step isn't wasted.
- **Conversation history mismatch (text history + structured output)** → Moot: audit mode is stateless (Decision 11). `run` mode is untouched.
- **Cost overrun on large max-steps values** → Default capped at 25. CLI warns if user passes `--max-steps > 40`. Single API call per step keeps per-step cost comparable to `run` mode. Token usage tracked per step (Decision 9) with budget warning threshold.
- **App crashes mid-audit** → Loop handles action errors; if bundle disappears for 2 consecutive steps, `AuditError('E_APP_CRASHED')` is raised and a partial report is finalized via JSONL (Decision 12).
- **Cultural bias of Norman/Nielsen on CJK apps** → Comparative anchoring is a swappable prompt section. Phase 1 ships with iOS HIG only; `--standards` flag with `ios-hig | material | cjk-mobile` presets is a Phase 2 addition.
- **Feature overlap with `phone-explore`** → Explicit positioning: `phone-explore` = fast reconnaissance (5–10 steps, screen map only); `audit` = deep analysis (25 steps, full UX report). Both are documented in README with a "when to use which" table.
- **Animation frames polluting analysis** → Action-type-based stability wait (Decision 10). Non-navigation actions keep existing delays. Configurable via `--stable-timeout`.
- **Crash or SIGINT loses accumulated findings** → Append-only JSONL (Decision 12). `finalizeReport()` called from async shutdown handler. Even SIGKILL leaves valid JSONL that can be manually rendered.
- **Screenshots contain PII** → Documented risk (Decision 17). Default output path excluded from git. Phase 2 adds `--redact`.
- **Model incompatibility discovered mid-run** → Fallback streak counter (Decision 14). 3 consecutive `NoObjectGeneratedError` → clear error code and model suggestion.
- **WDA / iproxy crash mid-audit** → Screenshot retry with exponential backoff + driver liveness check (Decision 14). Clear error codes distinguish device-locked vs driver-crashed.
- **Concurrent audits on same device** → File-based per-device lock (Decision 17). Second run gets immediate error, not undefined behavior.
- **First-run onboarding wastes steps** → Prompt directive to skip tutorials (Decision 17). Steps tagged `onboarding: true` excluded from coverage metrics.
- **Gemini free-tier rate limits hang the audit** → Proactive rate limiter + hard 45 s per-step timeout (Decision 19). Free tier caps at 12 RPM; paid tier configurable.
- **iOS 26 physical device has no working runner** → Phase 1 restricted to iOS 26 simulator (Decision 20). Physical device is a Phase 2 research task.
- **Sharp SVG annotation quality unknown at design time** → POC (OPS-1) verified English + CJK (PingFang TC) render cleanly at retina resolution in ~200 ms/step. No new dependency required.
- **generateObject + Gemini vision compatibility unverified at design time** → POC (OPS-2) confirmed schema compliance, optional-block omission, vision input reading, and correct `tapText` preference over hallucinated coordinates.

## POC Findings (validated before implementation)

Three operational POCs were run against the live stack before committing to Phase 1:

| POC | Validated | Result | Score |
|-----|-----------|--------|-------|
| OPS-1 | `sharp.composite` + inline SVG annotation (English + CJK) | Font stack `-apple-system, "PingFang TC", sans-serif` renders crisply at retina; ~209 ms composite time per 25-step run adds ~5 s total | 9.25/10 |
| OPS-2 v2 | `generateObject` + Gemini 2.5 Flash + vision input + Zod schema | `text`-preferred over `x/y`, `audit` block correctly omitted on clean screens, `progress` returned as integer 0-100 after `.describe()` tightening, ~700 tokens per call (≈ $0.003 per 25-step audit — 7× cheaper than design-time estimate because of Gemini's automatic prompt caching) | 9.25/10 |
| OPS-19 | Free-tier Gemini rate-limit behavior under sustained audit load | 240 s exponential backoff observed on a single call during 3-concurrent-POC burst. Confirmed rate limiter is required, not optional. | — (discovery) |

## Migration Plan

Not a migration — additive feature. Rollout steps:
1. Ship behind the `audit` subcommand only; `run` is untouched
2. Internal dogfood: run audit against 3–5 apps the team uses, manually review all reports
3. Gate public release on FP rate < 20% from internal review
4. Document in README with the "when to use which" table alongside `phone-explore`

Rollback: delete the new files and the `audit` case in `index.ts`. No shared state to unwind.

## Open Questions

- Should the audit report include a numerical "overall UX score" per screen? Risk: encourages gaming the metric. Leaning toward: track it internally in `AuditReport` but keep it out of the default Markdown output until Phase 2.
- What is the right default for `--max-steps` in audit mode? 25 is the working assumption; real runs in Phase 1 will validate whether 20 or 30 is better.
- Should sub-pages found during exploration be scored the same as top-level screens, or given less weight in the summary? Defer until we have data from Phase 1 runs.
