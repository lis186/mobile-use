# Phase 2 Backlog — UX Audit Report Quality

> Source: Codex devil's advocate review of Phase 1 dogfood reports (2026-04-13).
> Phase 1 delivered the end-to-end pipeline. Phase 2 focuses on **output quality**.

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

### M1. False negative blind spots (structural)

The vision model fundamentally cannot assess:
- **VoiceOver / Rotor focus order** — requires running VoiceOver, not just reading the tree
- **Dynamic Type truncation** — requires switching to large text sizes
- **Animation timing / gesture cancellation** — requires temporal analysis across frames
- **Information architecture depth** — requires a graph-level view of the screen map, not per-screen analysis
- **Cross-screen state consistency** — requires memory the stateless agent doesn't have

**Fix direction (incremental)**:
- IA depth: after the run, analyze the screen map graph (already captured) and flag screens > 4 taps deep with no shortcut.
- Dynamic Type: add a `--accessibility-pass` flag that restarts the audit with large text enabled and compares layouts.
- VoiceOver: Phase 3 — requires a VoiceOver automation bridge that doesn't exist yet.

### M2. Exploration efficiency — ⏳ PARTIAL (Sprint 1)

> Partial fix: consecutive swipe escape (`d31ec6f`), specimen screen filter (`38115c2`), subtree relaunch escalation + step budget estimation (`c579c0b`). Remaining: flow-level dedup (track 3-step sequence patterns) — Sprint 2.

Agent gets stuck in loops (Maps "Add to List" cycle, Safari customization loop). The visited-screen fingerprint doesn't prevent re-entering the same flow from a different entry point.

**Fix direction**:
- Track visited **flows** (sequence of 3+ screen fingerprints) in addition to individual screens.
- If the current 3-step sequence matches a previously seen flow, force a `back()` instead of continuing.

**Estimated effort**: ~50 LOC in audit-executor.ts.

---

## Low — Nice-to-have

### L1. Contrast ratio measurement tool

Wire `sharp` pixel sampling to extract foreground/background color at a flagged element's coordinates, compute WCAG 2.1 contrast ratio, and include the real number. Would eliminate the most embarrassing class of hallucinated measurements.

### L2. Physical device support (Decision 20 Phase 2)

iOS 26 WDA driver validation + physical device test matrix.

### L3. `generateObject` → AI SDK v6 migration

Deprecation warnings are currently suppressed. When AI SDK ships the replacement API with structured-output + vision guarantees, migrate.

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
| M1 | Medium | varies | Covers blind spots incrementally | Sprint 2 | |
| M2 | Medium | ~50 LOC | Better exploration coverage | Sprint 1–2 | ⏳ PARTIAL |
| L1 | Low | ~60 LOC | Nice-to-have precision | Sprint 2 | |
| L2 | Low | large | Phase 2 feature | Sprint 3 | |
| L3 | Low | medium | Tech debt | Sprint 3 | |

**Sprint 1 total**: ~275 LOC across prompt, schema, executor, and dedup. High ROI — transforms the report from "automated noise + correct terminology" (2/10) to "useful first-pass screening tool" (target: 6-7/10).
