# Audit Feature Backlog

> Canonical backlog for `phone-use audit`. Covers Phase 2 (report quality), post-Phase-2 exploration improvements, open bugs, sprint records, and operational notes.
> Phase 1 delivered the end-to-end pipeline. Phase 2 focused on **output quality**. All Phase 2 items ✅ done (E1 shipped 2026-04-21; L3 already on v6).

---

## Critical — Must fix before external-facing use

### C1. Measurement hallucination → use real frame data — ✅ DONE (Sprint 1)

> Implemented: real frame dimensions in tree output. Commit: `397f74f`.

**Problem**: The vision model estimates sizes as screen-percentage then multiplies by assumed device dimensions ("approximately 22.5pt"). These numbers are often wrong — it mistakes text bounding boxes for hit areas, ignores iOS hit slop (extendedEdgeInsets), and produces "likely below 4.5:1" without ever computing a contrast ratio.

**Why it matters**: Every issue that cites a pixel/point measurement is unverifiable. A human reviewer cannot trust the numbers, which undermines the entire "evidence-based" claim.

**Fix direction**:
- Parse `frame: { X, Y, Width, Height }` from the accessibility tree's AXElement data (already returned by XCTest viewHierarchy) and inject actual point dimensions into the prompt context.
- For contrast: extract dominant foreground/background colors from the screenshot region around the flagged element using sharp pixel sampling. Compute WCAG contrast ratio and include the real number in the evidence.
- Prompt: require `measured_width_pt` / `measured_height_pt` / `contrast_ratio` fields in the Zod schema so the model must commit to numbers that can be cross-checked.

**Estimated effort**: ~150 LOC (frame extraction + color sampling + schema extension + prompt update).

---

### C2. Principle grounding is name-dropping, not analysis — ✅ DONE (Sprint 1)

> Implemented: cognitiveImpact field + GOOD/BAD examples. Commit: `c524072`.

**Problem**: Issues cite "Nielsen:Consistency" or "Norman:Affordance" as labels but don't explain HOW the user's cognition fails. A real Norman analysis would describe the gulf of execution or evaluation; a real Nielsen analysis would explain which heuristic is violated and what the user experiences as a result.

**Why it matters**: Without causal reasoning, the principle tag is decorative. A developer reads "Norman:Affordance" and still doesn't understand why the design is wrong.

**Fix direction**:
- Prompt: add a required `cognitiveMechanism` field (or rename `evidence` to require two parts: **observation** + **cognitive impact**). Example: "The row lacks a chevron (observation), so a first-time user cannot distinguish tappable rows from static labels without trial-and-error (cognitive impact per Norman's gulf of evaluation)."
- Add GOOD/BAD examples that contrast shallow labeling vs. causal analysis.

**Estimated effort**: ~30 LOC prompt change + schema field. High leverage.

---

### C3. Scope pollution — agent leaves the target app — ✅ DONE (Sprint 1)

> Implemented: scope guard with app identifier check. Commits: `683eaef`, `755a743`.

**Problem**: The Settings audit report contained Maps screens ("Save to My Guides", "喜好地點"). The agent tapped a link that left the app, and continued auditing whatever was in the foreground.

**Why it matters**: A report for `com.apple.Preferences` that contains Maps findings is fundamentally broken. Trust = 0.

**Fix direction**:
- `detectAppCrash()` was hard-coded to `false` in Phase 1 and has since been fixed (commit `13ee270`) to use empty-tree heuristics. Verify this actually prevents cross-app drift in a rerun.
- Additional safeguard: after each action, compare the accessibility tree's root Application element identifier against `auditConfig.bundleId`. If mismatch, immediately `back()` and log a warning rather than continuing to audit the wrong app.

**Estimated effort**: ~30 LOC in audit-executor.ts.

---

## High — Fix before dogfood round 2

### H1. Dedup still leaks near-duplicates — ✅ DONE (Sprint 1)

> Implemented: three-pass dedup (exact → fuzzy same-screen → cross-screen principle). Commits: `b57718f`, `76f977e`.

**Problem**: Report-level dedup matches on `screenName + title` exactly. Safari ISSUE-001/002 ("Rearrange icon" vs "Reorder handle" — same element, different wording) and Settings ISSUE-004/005 both slipped through. The prompt says "don't re-report" but the model rephrases.

**Fix direction**:
- Case-insensitive title comparison (trivial).
- Fuzzy dedup: compute Jaccard similarity on title bigrams; if > 0.6 AND same screenName, deduplicate.
- Alternatively: add a `elementId` or `elementDescription` field to the schema so dedup can match on the target element rather than the title string.

**Estimated effort**: ~40 LOC.

### H2. Anti-Apple bias — flagging standard platform patterns — ✅ DONE (Sprint 1)

> Implemented: added anti-patterns for modal sheets, chrome, pull-to-refresh, back button labels, font specimens. Commits: `4cccd00`, `57d937f`.

**Problem**: iOS modal sheets without an explicit "Done" button were flagged as Medium. Standard iOS navigation (swipe-to-dismiss, implicit sheet dismissal) is correct per HIG. The prompt's anti-pattern list covers tab bars and back buttons but not sheets.

**Fix direction**:
- Add to Layer 3 anti-patterns: "iOS modal sheets that can be dismissed by swiping down are standard — do not flag the absence of a Done/Close button as a UX issue."
- Add: "Accessibility-tree elements marked as buttons that are standard iOS UI chrome (status bar, home indicator) are not actionable UX issues."

**Estimated effort**: ~5 LOC prompt update.

### H3. Severity calibration is inconsistent — ✅ DONE (Sprint 1)

> Implemented: explicit severity rubric with measurement thresholds. Commit: `b2cedf2`.

**Problem**: A tap target 3.4pt below minimum was rated Low in Maps but a similar delta was Medium in Safari. No consistent severity rubric.

**Fix direction**:
- Add explicit severity rules to the prompt:
  - High: blocks task completion or causes data loss
  - Medium: causes measurable friction (tap target < 34pt, contrast < 3:1, error with no recovery)
  - Low: minor friction (tap target 34–44pt, contrast 3:1–4.5:1, cosmetic inconsistency)
- Alternatively: compute severity from the measured values programmatically in `toStepResult` rather than letting the model decide.

**Estimated effort**: ~20 LOC prompt + optional 15 LOC post-processing.

---

## Medium — Quality-of-life improvements

### M1. False negative blind spots (structural) — ✅ DONE (Sprint 2)

> Implemented: IA depth analysis in report (`36b360d`), Dynamic Type pass via `--accessibility-pass` (`2921705`). VoiceOver deferred to Phase 3 (requires automation bridge).

The vision model fundamentally cannot assess:
- **VoiceOver / Rotor focus order** — Phase 3, requires VoiceOver automation bridge
- **Dynamic Type truncation** — ✅ `--accessibility-pass` flag reruns audit at XL text size
- **Animation timing / gesture cancellation** — out of scope
- **Information architecture depth** — ✅ post-run graph analysis flags screens > 4 taps deep
- **Cross-screen state consistency** — out of scope for stateless agent

### M2. Exploration efficiency — ✅ DONE (Sprint 2)

> Implemented: flow-level 3-screen fingerprint cycle detection (`3e51e60`). Complements P3 (consecutive swipe escape), P4 (per-fingerprint relaunch). Commit: `3e51e60`.

Agent gets stuck in loops (Maps "Add to List" cycle, Safari customization loop). The visited-screen fingerprint doesn't prevent re-entering the same flow from a different entry point.

**Fix**: `flowHistory` (last 3 fingerprints) + `visitedFlows` Set. If the current 3-screen sequence has been seen before, force `back()` and inject STUCK message. In `audit-executor.ts`.

---

## Low — Nice-to-have

### L1. Contrast ratio measurement tool — ✅ DONE (Sprint 2)

> Implemented: `sharp` pixel sampling at flagged element coordinates, WCAG 2.1 contrast ratio injected into persisted issues. Commit: `e11caf9`.

### L2. Physical device support (Decision 20 Phase 2) — ✅ DONE (Sprint 3)

> Implemented: Phase 1 gate removed; `--runner wda --ios-device <UDID> --team-id <TEAM_ID>` now fully supported. Validated on iPhone iOS 26.3.1. Commit: `90e7167`.

### L3. `generateObject` → AI SDK v6 migration — ✅ DONE (already on v6)

Project depends on `ai ^6.0.5` and `@ai-sdk/google ^3.0.2` / `@ai-sdk/openai ^3.0.2` (the v6-era line). `generateObject()` is the v6 idiom — no migration needed. No deprecation suppression in code.

v7 is currently in beta (`ai 7.0.0-beta.111`, `@ai-sdk/google 4.0.0-beta.45`); revisit when it stabilises.

---

## Post-dogfood fixes (Sprint 1)

### P1. Font specimen false positives — ✅ DONE (Sprint 1, post-dogfood)

**Problem**: Font preview screens flagged for thin font contrast. Anti-pattern rule overridden by HIG contrast rules.

**Fix**: Triple-layer defense — prompt CONTEXT FILTER + BAD example + code-level `isSpecimenScreenIssue()` post-filter.

**Commit**: `38115c2`

### P3. Paginated content stuck loop — ✅ DONE (Sprint 1, post-dogfood)

**Problem**: Agent wasted 18/25 steps swiping through font preview pages.

**Fix**: Consecutive swipe counter (MAX=4) forces back navigation + STUCK message injection.

**Commit**: `d31ec6f`

### P4+P5. Subtree trap + step budget estimation — ✅ DONE (Sprint 1, post-dogfood)

> Implemented: per-fingerprint relaunch escalation (P4) + home-screen coverage estimate (P5). Commit: `c579c0b`.

**Problem**: Agent escapes paginated content but re-enters same subtree. No global exploration diversity signal. 25 steps insufficient for full app coverage with no visibility into budget adequacy.

**Fix (P4 — Stuck Escape with Relaunch Escalation)**:
- `MAX_OVEREXPLORED_VISITS = 4`: when the same fingerprint is seen ≥ 4 times, back() alone can't escape the subtree.
- `relaunched: Set<string>`: each fingerprint gets exactly one relaunch attempt. Prevents multi-screen subtrees from exhausting the escape budget.
- Relaunch calls `launchApp` via `executeAction`, then `waitForScreenStable` to let the home screen settle.
- Visited map is preserved across relaunch so already-explored screens are not re-audited.
- Relaunch failure degrades gracefully: warning logged, loop continues (best-effort).

**Fix (P5 — Step Budget Estimation)**:
- At step 1, if a rich tree is available, `extractNavTargets` counts top-level sections.
- Displays `N sections × 3 steps ≈ M steps needed` and computes `--max-steps` coverage percentage.
- Warns if coverage < 60% with a suggested `--max-steps` value.

**Sprint 2 backlog** (pending validation that relaunch fix is sufficient):
- Overview mode (`--overview`) for section mapping
- Deep dive auto mode (`--deep`) for sequential section audit
- Deterministic replay navigation (nav steps vs audit steps separation)
- `--snapshot` / `--setup` for state restoration across sessions
- Coverage.json persistence + cross-session report merge

---

## Priority matrix

| ID | Severity | Effort | Impact on trust | Sprint | Status |
|----|----------|--------|-----------------|--------|--------|
| C1 | Critical | ~150 LOC | Eliminates hallucinated measurements | Sprint 1 | ✅ DONE |
| C2 | Critical | ~30 LOC | Transforms shallow labels into real analysis | Sprint 1 | ✅ DONE |
| C3 | Critical | ~30 LOC | Prevents scope pollution | Sprint 1 | ✅ DONE |
| H1 | High | ~40 LOC | Removes duplicate noise | Sprint 1 | ✅ DONE |
| H2 | High | ~5 LOC | Stops flagging Apple's own patterns | Sprint 1 | ✅ DONE |
| H3 | High | ~20 LOC | Makes severity ratings trustworthy | Sprint 1 | ✅ DONE |
| P1 | Post-dogfood | ~30 LOC | Eliminates font specimen false positives | Sprint 1 | ✅ DONE |
| P3 | Post-dogfood | ~40 LOC | Breaks paginated content stuck loops | Sprint 1 | ✅ DONE |
| P4+P5 | Post-dogfood | ~60 LOC | Subtree escape + step budget | Sprint 1 | ✅ DONE |
| M1 | Medium | varies | Covers blind spots incrementally | Sprint 2 | ✅ DONE |
| M2 | Medium | ~50 LOC | Better exploration coverage | Sprint 2 | ✅ DONE |
| L1 | Low | ~60 LOC | Nice-to-have precision | Sprint 2 | ✅ DONE |
| L2 | Low | large | Phase 2 feature | Sprint 3 | ✅ DONE |
| L3 | Low | medium | Tech debt | Sprint 3 | ✅ DONE (already on v6) |
| E1 | Medium | ~60 LOC | Prevents step-budget waste from subtree trap | Post-Phase-4 | ✅ DONE (`8ff2ab9`) |

**Sprint 1 total**: ~275 LOC across prompt, schema, executor, and dedup. High ROI — transforms the report from "automated noise + correct terminology" (2/10) to "useful first-pass screening tool" (target: 6-7/10).

---

## Post-Phase-4 — Exploration Breadth

### E1. Subtree breadth guard — ✅ DONE (`8ff2ab9`, 2026-04-21)

> Source: Phase 4 dogfood observation (2026-04-21). Pre-mortem completed before implementation. Codex review caught a missing `resetStuckCounters()` on the WDA scope-drift escape path; fixed in the same commit.

**Problem**: The Phase 4 real-device dogfood (Settings, 25 steps) showed the agent spending 15+ steps in the Apple Account → Personal Information subtree without reaching top-level sections (Wi-Fi, Privacy). The flow loop guard (3-fingerprint cycle) fired once at step 8 but the subtree had enough unique fingerprints that the same 3-tuple never repeated. No other stuck mechanism caught it.

**Why it matters**: With a 25-step budget, 15 steps in one subtree = 60% budget wasted on a section with zero UX issues. Breadth coverage is the primary value driver for a general-purpose auditor.

**Root cause**: All existing stuck guards (P3 consecutive swipes, M2 flow loop, P4 overexplored screen) detect *repetition*. They do not detect *linear descent into unexplored but fruitless territory* — the agent was seeing new fingerprints every step, so nothing triggered.

**Fix direction**:

Add a `subtreeDepth` counter and `consecutiveDeepSteps` counter to `AuditExecutor`. `subtreeDepth` tracks how many levels below the app root the agent currently is, based on executed navigation actions. `consecutiveDeepSteps` counts how many consecutive steps have been at depth > `MAX_SUBTREE_DEPTH`. When `consecutiveDeepSteps >= MAX_CONSECUTIVE_DEEP_STEPS`, force `launchApp` to return to root.

**Pre-mortem findings and approved solutions** (all scored ≥ 9/10):

| Risk | Solution | Score |
|------|----------|-------|
| P4 relaunch + subtree trap double-fire | `resetStuckCounters()` helper called by ALL escape paths | 9/10 |
| Failed action inflates depth | `actionSucceeded` flag; `updateSubtreeDepth()` only called on success | 10/10 |
| Threshold 8 too aggressive for legitimate deep apps | Default `10`, exposed as `--max-subtree-depth-steps <n>` CLI flag | 10/10 |
| Onboarding taps inflate initial depth | `updateSubtreeDepth(action, isOnboarding)` — onboarding steps don't increment | 10/10 |
| depth threshold `3` hardcoded | Default `3`, exposed as `--subtree-depth-threshold <n>` CLI flag | 10/10 |
| Agent re-enters same subtree after launchApp | Accepted tradeoff — visited map prevents re-auditing; breadth improves over multiple cycles | — |

**Implementation plan** (single file: `src/audit-executor.ts` + `src/types.ts` + `src/index.ts`):

1. Add constants: `MAX_SUBTREE_DEPTH` (default 3), `MAX_CONSECUTIVE_DEEP_STEPS` (default 10)
2. Add fields: `subtreeDepth: number`, `consecutiveDeepSteps: number`
3. Extract `resetStuckCounters()` — sets all three swipe/depth/consecutive counters to 0; call at every `continue` in every escape path (P3, flow loop, P4, new subtree trap)
4. Extract `updateSubtreeDepth(action, isOnboarding)` — `launchApp` resets to 0, `back` decrements (min 0), other nav actions increment if `!isOnboarding`; recomputes `consecutiveDeepSteps`
5. Add subtree trap check block (after P4, before executeAction): if `consecutiveDeepSteps >= MAX_CONSECUTIVE_DEEP_STEPS`, force launchApp, call `resetStuckCounters()`, inject STUCK message, `continue`
6. Call `updateSubtreeDepth` only when `actionSucceeded === true`
7. Add `maxSubtreeDepthSteps?: number` and `subtreeDepthThreshold?: number` to `AuditConfig` in `types.ts`
8. Wire CLI flags `--max-subtree-depth-steps` and `--subtree-depth-threshold` in `src/index.ts`

**Estimated effort**: ~60 LOC across three files.

---

## Open Bugs

### BUG-A · `xctest.ts` tapText fails on curly apostrophe — ⏳ DEFERRED (low real-world ROI)

**Observed**: `tapText("Don't have an Apple Account?")` → `[XCTest] Element not found`.

**Cause**: Element on screen uses typographic `'` (U+2019); element's stored accessibility label uses ASCII `'` (U+0027) or vice versa. XCTest element search is exact-match by default. Same family of bugs covers smart double quotes (U+201C/D), ellipsis (U+2026), em/en dashes (U+2013/4).

**Fix location**: extract `normalizeForMatch()` to `src/core/text-match.ts`; use it from both `xctest.ts` `findElementByText` and the `wda.ts` accessibility-tree-XML CJK fallback. NFKC + symmetric smart-quote / ellipsis / dash replacement + ZWJ stripping. ~25 LOC + unit tests with explicit codepoint escapes.

**Severity**: ~~Medium~~ → **Low**. Audit loop handles failures gracefully (fail-silent, continues), so report quality is unaffected — only wastes steps when triggered.

**ROI verification (2026-04-22)**: Across 5 retained audit runs (`audit-output/2026-04-2{0,1}*` + `dt-dogfood` + `settings-sprint2`), 43 tapText invocations, **0** targets contained smart punctuation. CJK UI dominant; failure mode never observed in retained logs. The original `"Don't have an Apple Account?"` observation came from an earlier run not preserved on disk.

**Trigger to revisit**: next English-UI dogfood (or any audit run where stdout shows `[XCTest] Element not found` on a string containing smart punctuation).

---

## Sprint Records

### Sprint 1 — Report Quality Fixes (2026-04-13)

**Branch**: `phase2-sprint1` → merged to `main`
**Goal**: Report quality 2/10 → 6-7/10

| ID | Fix | Commits |
|----|-----|---------|
| C1 | Real frame dimensions in tree output | `397f74f` |
| C2 | `cognitiveImpact` field + GOOD/BAD examples | `c524072` |
| C3 | Scope guard (cross-app drift detection) | `683eaef`, `755a743` |
| H1 | Three-pass dedup (exact → fuzzy → cross-screen) | `b57718f`, `76f977e` |
| H2 | Anti-patterns (modal, chrome, back button, font specimen) | `4cccd00`, `57d937f` |
| H3 | Severity calibration rubric | `b2cedf2` |
| P1 | Font specimen triple-layer defense | `38115c2` |
| P3 | Consecutive swipe escape heuristic | `d31ec6f` |
| P4+P5 | Per-fingerprint relaunch escalation + step budget estimation | `c579c0b` |

**Dogfood progression** (Settings, 25 steps, xctest simulator):

| Run | Issues | FP rate | Key finding |
|-----|--------|---------|-------------|
| v1 (pre-fix) | 4 | 75% | Flagging iOS standard elements |
| v2 (C1–H3) | 13 | 77% | 8 duplicate font contrast issues |
| v3 (+ P1) | 5 | 80% | Font preview still leaking through |
| v4 (+ P1 triple-layer) | 0 | 0% | Agent trapped in font subtree, no escape |
| V1 final (+ P4+P5) | 2 | 0% | 14 unique screens, flow guard working |

**Key design decisions from pre-mortem**:
- Relaunch over back: subtree escape must go to app root, not one level up
- Step estimation at step 1 before committing to audit path
- Overview/deep-dive mode deferred (scope creep risk)
- Deterministic replay deferred (path fragility risk)

---

### Sprint 2 — Exploration Quality + Structural Findings (2026-04-19)

**Branch**: `phase2-sprint2` → merged to `main`
**Tests**: 118/118

| ID | Fix | Commits | Key change |
|----|-----|---------|------------|
| M2 | Flow-level 3-fingerprint cycle detection | `3e51e60`, `512eee5` | `flowHistory[]` + `visitedFlows Set` in executor |
| M1 | IA depth analysis — flags screens > 4 taps deep | `36b360d`, `87f734a` | `buildDepthMap()` + `renderDepthFindings()` in report |
| L1 | WCAG 2.1 contrast ratio via pixel sampling | `e11caf9` | `src/core/contrast.ts` new; p12.5/p87.5 anchor sampling |

**M1 depth tracking** (relevant to E1 design): `buildDepthMap` in `audit-report.ts` does a single pass — increment on forward nav, decrement on `back`, reset on `launchApp`. This is the same model used for the new E1 runtime counter.

---

### Phase 3 — Dynamic Type Pass (2026-04-20)

**Branch**: `phase3-m1-dt-pass` → merged (`1ad60d5`)

Added `--accessibility-pass` flag: reruns the full audit at `accessibility-extra-large` text size to catch truncation issues invisible at default size. Dogfood on Settings found 3 Dynamic Type issues (label truncation in Wi-Fi detail views).

---

### Phase 4 — Physical Device Support (2026-04-21)

**Branch**: `phase4-l2-physical-device` → merged (`1d46319`)

Removed Phase 1 simulator-only gate. `--runner wda --ios-device <UDID> --team-id <ID>` now fully supported.

**WDA first-launch note**: `xcodebuild test-without-building` fails on first install (entitlement error). Use `xcodebuild test` for the first launch, then `test-without-building` for subsequent runs. See `CLAUDE.md` for the full startup sequence.

**Dogfood** (Settings, 25 steps, real iPhone iOS 26.3.1):

| Metric | Value |
|--------|-------|
| Steps | 24 (1 onboarding excluded) |
| Unique screens | 11 |
| Issues | 5 (3 Medium, 2 Low) |
| Cost | $0.0126 |
| Wall-clock | 6 min 21 s |
| Flow loop triggered | Step 8 ✅ |
| Scope drift guard triggered | Step 21 ✅ |

**Observed limitation** (→ source of E1): agent spent 15+ steps in Apple Account subtree, never reached Wi-Fi/Privacy. Flow loop fired once at step 8 but the subtree had new unique fingerprints every step, so the 3-tuple check didn't re-trigger.

---

## Operational Notes

### Gemini free-tier quota

The blocker is the **daily request (RPD)** budget, not RPM. Three runs exhausted the daily budget in one session regardless of `--rpm-limit`. Key evidence: attempt 23 minutes after the previous run still failed on the first call — ruling out any per-minute explanation.

- Safe settings for a fresh daily budget: `--rpm-limit 5 --max-retries 0`
- A 25-step run is ~25 calls; fits under free-tier RPD most days if it's the only run
- Do not retry with lower RPM once the daily bucket is gone — it does not help
- Daily quota resets at UTC midnight
- Paid Gemini tier or `gemini-2.5-flash-lite` (separate bucket, untested) as alternatives

### Performance baselines (xctest simulator, gemini-2.5-flash)

From Phase 1 smoke test (2026-04-11, 5 steps):

| Metric | Value |
|--------|-------|
| AI latency p50 | 5.35 s |
| AI latency p95 | 6.74 s |
| Screenshot p50 | 330 ms |
| Total step p50 | 7.43 s |
| Cost per 25-step run | ~$0.006–$0.013 |

Real device (WDA, Phase 4 dogfood): 24 steps in 6 min 21 s (~16 s/step including rate-limiter pacing).

### Live viewer (Group 14A)

`--live` flag infrastructure exists in the codebase (`LiveViewer` import + opt-in branch in executor). The actual `src/core/live-viewer.ts` implementation is **not built**. The flag is documented but silently no-ops if the module is missing. This is intentional — Phase 1 shipped annotation-always, live-viewer-opt-in (Decision 18). Build when there's demand.
