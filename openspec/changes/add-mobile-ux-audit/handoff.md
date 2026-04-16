# Session Handoff — add-mobile-ux-audit

> **Read this first.** This file captures everything the next session needs to resume work on `feature/mobile-ux-audit` without re-deriving context.
> Last updated: **2026-04-12** after Path B batch (SIGINT cancel + ops hygiene + docs + CI workflow).

---

## TL;DR

- **Branch**: `phase2-sprint1` (based on `main` which contains merged Phase 1)
- **Progress**: **Phase 1 merged to main.** Sprint 1 (Phase 2) focuses on report quality fixes — from 2/10 → 6-7/10.
- **Status**: Sprint 1 C1-C3, H1-H3, P1, P3, P4, P5 all implemented. V1 dogfood ready to run.
- **Last commit**: `d31ec6f fix(audit): P3 — escape heuristic for paginated content stuck loops`
- **Working tree**: clean (ignore local `audit-output/` dir if present)
- **Next obvious step**: run V1 dogfood verification (25-step Settings audit on clean simulator).

---

## 0 · Repository state

```
feature/mobile-ux-audit HEAD:
  9d7c194 docs(audit)+ci: Path B — Groups 18.1, 19.3
  1476442 docs(audit): Path B — Groups 16.1/16.3, 18.2/18.3/18.4, 19.4
  8197f7b feat(audit): Path B — Groups 14.2–14.4, 18.5, 19.1 (SIGINT cancel + ops hygiene)
  edb8065 docs(openspec): handoff — Gemini daily quota, not RPM, is what's blocking dogfood
  659c95a docs(openspec): update handoff with 540c37f status + Gemini quota findings
  540c37f fix(audit): Phase 1.5 smoke-test bug fixes (BUG-B + OBSERVATION-C)
  6b141f2 docs(openspec): session handoff file for add-mobile-ux-audit
  018bc80 feat(audit): Markdown report renderer (Group 13 + test 15.5)
  71fd904 refactor(audit): simplify pass on Groups 10-12
  06e089d feat(audit): AuditExecutor loop + CLI wire-up (Groups 10-12, 14.1)
  1c4a833 fix(audit): Group 8/9 Codex review — 3 High + 1 Minor
  1deeb5f feat(audit): CLI subcommand + AuditAgent (Groups 8, 9)
  30f5959 test(audit): unit tests for foundation modules (Groups 15, 20.1)
  c26164e fix(audit): foundation review fixes from Codex pass
  0786ea2 feat(audit): foundation modules for audit mode (Groups 1-7A)
  4cd9781 docs(openspec): add Phase 1 dogfood runbook
  d670e98 docs(openspec): propose add-mobile-ux-audit change
  9cdc2d5 Improve executor parallelism and WDA connection resilience   ← pre-branch
```

**What the 2026-04-12 Path B batch did** (commits `8197f7b`, `1476442`, `9d7c194`):

- **Group 14.2** — SIGINT now calls `AuditExecutor.cancel()` via a module-scope `auditCancelCallback` hook in `src/index.ts`. The executor's `runLoop` checks a `cancelRequested` flag at the top of every iteration and throws `E_USER_ABORTED` after the loop so the existing `try/finally` still runs `finalize()`. Run mode is unaffected (callback is null outside audit).
- **Group 14.3** — `formatAuditError` now prints a `docs/audit-errors.md#<code>` deep link for every `AuditError`, plus a redacted stack for unknown errors.
- **Group 14.4** — already met by `runAuditCommand` (success → exit 0 even with issues; hard failure → thrown `AuditError` → exit 1). No code change, marked done in tasks.md.
- **Group 16.1 / 16.3** — diff sweep from `0786ea2..HEAD` on `src/agent.ts` + `src/executor.ts` confirms every change is a visibility bump (`private → protected`) or an `export`/extracted helper; no behavioural change to `run` mode. `tsc --noEmit` clean.
- **Group 18.1** — project `CLAUDE.md` updated: project-structure list now covers the audit surface, new "when to use which command" table contrasts `run` vs `audit`, known-limitations paragraph captures the Phase 1 scope + Gemini quota story.
- **Group 18.2 / 18.3 / 19.4** — new `README.md` "Autonomous UX Audit (Phase 1)" section: minimal invocation, `--skip-launch` LINE example, `--scope` example, explicit "outputs land in the CWD" note, report artefact layout, PII warning, pointer to error docs, Phase 1 scope note. `AuditConfig.outputDir` was already resolved via `path.resolve(process.cwd(), ...)` in `src/index.ts` — 19.4 is now documented, not just implemented.
- **Group 18.4** — new `docs/audit-errors.md`: one section per `AuditErrorCode` (9 sections), each with what-it-means / common-causes / try-first triage. Deep-linked from the CLI formatter.
- **Group 18.5** — `.gitignore` now excludes `audit-output/` with a PII comment.
- **Group 19.1** — `.env.example` now leads with `GOOGLE_GENERATIVE_AI_API_KEY` (audit default) + commented `OPENAI_API_KEY`. README installation step swapped from `export OPENAI_API_KEY=...` to `cp .env.example .env`.
- **Group 19.3** — new `.github/workflows/test.yml`: `tsc --noEmit` + `npm test` on `macos-latest` across Node 18 / 20 / 22, triggered on push to main/feature/**, and on PRs targeting main.

**What `540c37f` did** (already done before this session — kept for history):
- Schema: `screenName` moved from `auditBlockSchema` → top-level `auditDecisionSchema` (required, `.min(1)`)
- Agent: `AuditStepResult` gains a top-level `screenName: string`; `toStepResult` reads `obj.screenName`; `fallbackNavOnly` path reports `'(fallback)'` so the executor never sees `undefined`
- Executor: `runLoop` reads `result.screenName?.trim() || 'Screen@' + fingerprint`
- Prompt: new `EXPLORATION ANTI-PATTERNS` section tells the agent to back out of sign-in gates, external URLs, and payment/subscription walls, and to prefer unvisited top-level navigation
- Tests: 5 audit-schema test cases updated to include top-level `screenName`; new test `screenName is required at top level (BUG-B fix)`; total **107/107** passing

**Nothing unpushed except what's on this branch.** All work is local — never pushed to GitHub.

---

## 1 · What the feature is

`phone-use audit <bundleId>` is an autonomous mobile UX auditor. The AI agent systematically explores an iOS app and, for every screen it visits, applies a Norman/Nielsen-grounded UX assessment with iOS HIG anchoring. Each step produces an annotated screenshot (red marker + Action/Target/Why card) so the final Markdown report is self-explanatory.

**Phase 1 scope** (Decision 20): iOS 26 Simulator only via the `xctest` runner. Physical device support is deferred to Phase 2.

**Decision cross-reference** (all live in `openspec/changes/add-mobile-ux-audit/design.md`):

| # | Decision | Where it lives in code |
|---|----------|------------------------|
| 1 | `generateObject()` + Zod schema | `src/schemas/audit.ts`, `src/audit-agent.ts` `decideAudit()` |
| 2 | Three-layer UX quality control (evidence / anchoring / anti-patterns) | `src/audit-agent.ts` `buildAuditSystemPrompt()` + Zod `.describe()` strings + `confidence < 60` filter in `toStepResult()` |
| 3 | Screen fingerprint + visited map + nav-target extraction | `src/core/screen-fingerprint.ts`, `src/audit-executor.ts` |
| 9 | Per-step `performance.now()` + token usage | `src/core/step-timing.ts`, `src/audit-executor.ts` `recordStep()` |
| 10 | Action-type-based stability wait | `src/audit-executor.ts` `NAVIGATION_ACTIONS` |
| 11 | Stateless audit (state block IS the memory) | `src/audit-agent.ts` `decideAudit()` — no `this.conversationHistory` use |
| 12 | Append-only JSONL streaming | `src/core/jsonl-writer.ts`, `src/audit-executor.ts` |
| 13 | Content-hash evidence dedup + JPEG | `src/core/evidence.ts` |
| 14 | Fallback retry budget + device error classification | `src/audit-agent.ts` `fallbackStreak`, `src/audit-executor.ts` `observeWithRetry` |
| 15 | `AuditError` typed taxonomy | `src/errors/audit-errors.ts` |
| 16 | Unit tests via `node:test` (zero dep) | `tests/*.test.ts` — 106 passing |
| 17 | Lockfile + state block top-K + defaults grab-bag | `src/audit-executor.ts` `acquireLock`, `src/audit-agent.ts` `VISITED_TOP_K` |
| 18 | Annotated screenshots + (opt-in) live viewer | `src/core/annotate.ts`; live viewer **not yet built** (Group 14A) |
| 19 | Proactive rate limiter + hard per-step timeout | `src/core/rate-limiter.ts`, `src/audit-agent.ts` `Promise.race` + AbortController |
| 20 | Phase 1 iOS 26 Simulator only | `src/index.ts` `buildAuditConfig()` Phase 1 scope gate |
| 21 | Phase 1 test app triad (Settings / Maps / Safari) | Documented in `dogfood-runbook.md` |

---

## 2 · File map of the audit feature

```
src/
├── audit-agent.ts          ~330 LOC — AuditAgent extends TaskAgent, stateless decideAudit
├── audit-executor.ts       ~700 LOC — AuditExecutor extends TaskExecutor, main audit loop
├── audit-report.ts         ~320 LOC — renderReport + finalizeReport (Markdown + JSONL I/O)
├── executor.ts             (modified) — sleep exported, protected visibility on reuse surface,
│                                        extracted buildDriverFromTaskConfig
├── agent.ts                (modified) — TaskAgent.getModel: private → protected
├── index.ts                (modified) — audit subcommand, buildAuditConfig, runAuditCommand,
│                                        parseIntFlag, redactSecrets, formatAuditError
├── types.ts                (extended) — AuditConfig, AuditIssue, AuditReport, VisitedScreen,
│                                        StepTiming, StepRecord, TreeQuality
│
├── errors/
│   └── audit-errors.ts     ~40 LOC — AuditError class + 9 discriminated error codes
│
├── schemas/
│   └── audit.ts            ~130 LOC — Zod schema for AuditDecision (POC-validated descriptions)
│
└── core/
    ├── annotate.ts         ~220 LOC — annotateScreenshot + writeAnnotated (sharp SVG overlay)
    ├── evidence.ts         ~75 LOC  — saveEvidence with SHA-1 dedup + symlink fallback
    ├── jsonl-writer.ts     ~50 LOC  — appendStep / appendIssue / readJsonl
    ├── rate-limiter.ts     ~80 LOC  — GeminiRateLimiter (sliding window, injectable sleepFn)
    ├── screen-fingerprint.ts ~80 LOC — MD5-of-labels + perceptual-hash fallback
    ├── step-timing.ts      ~110 LOC — summarize() + estimateCost() + TimingSummary
    └── tree-parser.ts      (extended) — parseAccessibilityTreeDetailed, extractLabels,
                                          extractNavTargets; backward-compatible

tests/                      106 unit tests, runs in ~2 s via `node --import tsx --test`
├── smoke.test.ts
├── screen-fingerprint.test.ts   (12)
├── tree-parser.test.ts          (15)
├── audit-schema.test.ts         (13)
├── step-timing.test.ts          (11)
├── jsonl-writer.test.ts         (6)
├── evidence.test.ts             (6)
├── annotate.test.ts             (10)
├── rate-limiter.test.ts         (9)
└── audit-report.test.ts         (18)

openspec/changes/add-mobile-ux-audit/
├── proposal.md
├── design.md               21 decisions + POC findings + risks
├── specs/
│   ├── ux-audit/spec.md    18 requirements, ~70 scenarios
│   └── screen-observation/spec.md
├── tasks.md                80 / 111 done
├── dogfood-runbook.md      10-gate Phase 1 runbook
└── handoff.md              ← this file
```

---

## 3 · What's done vs. what's left

### ✅ Done (80 / 111)

| Group | Tasks | Notes |
|-------|-------|-------|
| 1 — Types & schemas | 3/3 | `AuditConfig`, Zod `AuditDecision`, `z.infer` |
| 2 — Error taxonomy | 2/2 | `AuditError` + 9 codes |
| 3 — Tree parser grading | 3/3 | rich / sparse / empty grades + extractors |
| 4 — Screen fingerprint | 3/3 | MD5 + perceptual hash |
| 5 — Step timing | 1/1 | P50/P95/avg + cost model |
| 5A — Rate limiter | 4/4 | 12 RPM default, injectable sleep for tests |
| 6 — JSONL writer | 2/2 | append-only + ENOENT tolerance |
| 7 — Evidence dedup | 3/3 | SHA-1 + JPEG + symlink |
| 7A — Annotation | 6/6 | SVG overlay, validated CJK + English |
| 8 — CLI config | 5/5 | 16 flags + Phase 1 scope gate |
| 9 — Audit agent | 11/11 | Stateless, AbortController, fallback streak |
| 10 — Executor scaffold | 5/5 | Lockfile, output dir, skip-launch |
| 11 — Exploration/stability | 3/3 | Visited map, nav targets, action-type wait |
| 12 — Persistence/evidence/timing/reliability | 8/8 | JSONL, timings, annotation, retry |
| 13 — Report writer | 10/10 | Full Markdown renderer (see §5 for live example) |
| 14.1 — CLI wiring | 1/4 | `runAuditCommand` wires executor; 14.2–14.4 not yet done |
| 15 — Unit tests | 9/9 | 106 passing |
| 20.1 — Rate limiter tests | 1/1 | done |

### ⏸ Left (31 / 111)

| Group | Tasks | Priority | Notes |
|-------|-------|----------|-------|
| **14 — CLI wiring final** | 3 | HIGH | `14.2` async signal handler + `finalizeReport()` on SIGINT; `14.3` richer `formatAuditError` (already mostly done); `14.4` exit code mapping — 14.1 is already done via `runAuditCommand`. Estimated ~50 LOC. |
| **14A — Live viewer** | 6 | MEDIUM (Phase 1.5-ish) | `src/core/live-viewer.ts`, SSE stream, browser auto-open. Opt-in via `--live`. Phase 1 Gates C/D don't require this but the spec says it's Phase 1. |
| **16 — Run-mode regression** | 3 | HIGH | `16.1` verify `run` behaviour unchanged (spot-check), `16.2` end-to-end `phone-use run` on sim, `16.3` final `tsc --noEmit` sweep. |
| **17 — Dogfood** | 10 | HIGH (acceptance gate) | `17.1–17.3` real audits of Settings / Maps / Safari; `17.4–17.10` FP review, coverage, parse rate, performance, token, rate-limiter observation. **One of the 17.x tasks is already partially done by the smoke test below — need ~20 more steps of real runs.** |
| **18 — Documentation** | 5 | MEDIUM | `CLAUDE.md` audit section + known-limitations block, `README.md` quickstart, LINE `--skip-launch` example, `docs/audit-errors.md`, `.gitignore` for `audit-output/`. |
| **19 — Ops readiness** | 4 | LOW | `.env.example`, Node engine range pinning + cross-version verify, GitHub Actions workflow, cwd-relative output doc. |

---

## 4 · Environment at handoff time

- **Machine**: macOS 26.2 Tahoe
- **Xcode**: `/Applications/Xcode-26.3.0.app` (26.3.0)
- **Node**: v25.8.2 (project `engines.node >=18.0.0`)
- **Booted simulator**: `iPhone 16 Pro (26.2)` UDID `47C95D20-2AF0-424C-95EC-0FB20D090BB8` — **still booted at handoff time**, with `Simulator.app` open. `xcodebuild` has already built the maestro driver XCTest bundle and cached it at `/tmp/maestro-driver-build/Build/Products/maestro-driver-ios_iphonesimulator26.2-arm64-x86_64.xctestrun`. Next audit run will skip the build step.
- **Physical device**: iPhone 15 Pro Max on iOS 26.3.1 is connected via USB but **not used in Phase 1** (Decision 20).
- **API keys**: `GOOGLE_GENERATIVE_AI_API_KEY` and `OPENAI_API_KEY` present in shell env (NOT in `.env` — `.env.example` is a Group 19 task that hasn't been done yet).
- **Gemini quota** (⚠️ revised 2026-04-12 — old note said 15 RPM, it's wrong): the blocker is NOT the RPM limit, it's the **RPD (daily request)** budget on `gemini-2.5-flash` free tier. Three attempts today — `--rpm-limit` 12, 4, and 5 — all died on `generate_content_free_tier_requests`. The decisive data point: attempt #3 ran 23 minutes after attempt #2 and still died on its very first call, which rules out any 60-second sliding-window explanation. See §5A for the full table and the revised lesson.
  - Today's daily budget is gone. Next working window is after UTC midnight.
  - Safe settings for a clean daily budget: `--rpm-limit 5 --max-retries 0`. One 25-step run is ~25–30 calls and should fit under the free-tier RPD ceiling (whatever it is — the API doesn't tell us the exact number, only that we crossed it).
  - Long-term fix: move off free tier (paid Gemini tier, or try `--model gemini-2.5-flash-lite` which may have its own bucket — untested).
- **Unit tests**: `npm test` → **107/107** passing in ~2 s (one new test added in `540c37f`).
- **Typecheck**: `npx tsc --noEmit` clean.
- **Build**: `npm run build` produces `dist/` cleanly.

---

## 5 · Smoke test results (2026-04-11, first real run)

### Command

```bash
node /Users/justinlee/dev/phone-use/dist/index.js audit com.apple.Preferences \
  --runner xctest \
  --device 47C95D20-2AF0-424C-95EC-0FB20D090BB8 \
  --max-steps 5 \
  --model gemini-2.5-flash \
  --rpm-limit 12 \
  --output-dir /tmp/audit-smoke
```

### Numbers

| Metric | Value | Budget | Status |
|--------|-------|--------|--------|
| Steps completed | 5 / 5 | — | ✅ |
| `generateObject` parse rate | 100 % (5/5) | ≥98 % | ✅ |
| AI p50 | 5.35 s | ≤12 s | ✅ |
| AI p95 | 6.74 s | ≤20 s | ✅ |
| Screenshot p50 | 330 ms | — | ✅ |
| Total step p50 | 7.43 s | — | ✅ |
| Input tokens | 9,843 (1,787 cached) | — | — |
| Output tokens | 1,836 | — | — |
| Cost | **$0.0012** | ≤$0.05 | ✅ |
| Wall-clock | ~1 min 52 s | — | — |
| Issues found | 0 | — | (expected — no real bugs on Settings first screen) |
| Annotated frames | 5 / 5 | — | ✅ |
| JSONL + timings.json + report.md | all present | — | ✅ |
| Rate limiter trigger | did not trigger | (intermittent expected) | — (will trigger on longer runs) |

### Artifact locations (from smoke)

```
/tmp/audit-smoke/
├── report.md
├── steps.jsonl
├── timings.json
├── annotated/step-01.jpg ... step-05.jpg    ← verified: CJK + English rendering OK
└── screenshots/                              ← empty (no issues)
```

### Example report header

```
# UX Audit Report: com.apple.Preferences
**Date**: 2026-04-11 06:42:05 UTC
**Device**: 47C95D20-2AF0-424C-95EC-0FB20D090BB8 (xctest runner)
**Model**: gemini-2.5-flash
**Duration**: 1 min 52 s · 5 steps (1 onboarding excluded)
**Coverage**: 3 unique screens visited (4 counted)
**Cost**: $0.0012 (9,843 in / 1,836 out tokens)
```

---

## 5A · 2026-04-12 session — Phase 1.5 fixes + dogfood attempt

### Fixes landed (`540c37f`)

Both bugs flagged in §6 are **FIXED** — see §0 for the per-file change summary. What this section adds is the *verification* pulled from the 2026-04-12 dogfood attempt before it was killed by rate limiting.

### Partial dogfood evidence (2026-04-12, 5 steps before quota blew up)

Command:

```bash
node dist/index.js audit com.apple.Preferences \
  --runner xctest \
  --device 47C95D20-2AF0-424C-95EC-0FB20D090BB8 \
  --max-steps 25 \
  --model gemini-2.5-flash \
  --rpm-limit 12 \
  --output-dir ./audit-output/settings-dogfood
```

Outcome: 5 steps executed, 6th call hit free-tier throttle, partial report written. The partial artefacts now live at `/tmp/settings-dogfood-partial-old/` (moved aside so the next run can start from a clean dir). The partial run was enough to verify both fixes:

- **BUG-B verified FIXED** — screen names in the partial `report.md` read `關於本機`, `關於本機 > iOS 版本詳情`, `憑證信任設定`, etc. No `Screen@<fingerprint>` fallback strings were rendered, even though some steps emitted zero issues. Before `540c37f` these would have been hex-only.
- **OBSERVATION-C verified FIXED** — step 1 decision prose: *"I am starting the exploration of the settings app by tapping on '一般' to navigate to a common settings section, **while avoiding account login flows for now**."* The new `EXPLORATION ANTI-PATTERNS` prompt section is steering the agent the way we wanted, on the first screen that previously walked straight into the Apple Account sign-in wall.
- **Real issue sample** — step 4 caught an iOS-version-detail overlay that has no explicit Done/X button (`confidence 90`, Nielsen:User control). Plausible, not a false positive. Not enough data yet to compute a real FP rate.

### Why every rerun kept failing — it's the DAILY quota, not RPM

Three attempts today, progressively more conservative, all died on the same `generate_content_free_tier_requests` metric:

| Attempt | `--rpm-limit` | `--max-retries` | Result |
|---|---|---|---|
| 1 | 12 | 1 (default) | 5 steps ran, step 6 tripped quota, `retry in 28 s` |
| 2 | 4 | 1 (default) | step 1 tripped quota, `retry in 20 s` |
| 3 | 5 | **0** | step 1 tripped quota, `retry in 31 s`, **23 minutes** after attempt #2 |

A 23-minute gap is more than twenty 1-minute sliding windows. If the limit were truly per-minute, attempt #3 could not have failed on its very first call. The only explanation that fits the data is that the blocker is the **daily** request budget on Gemini 2.5 Flash free tier, not the per-minute RPM limit. The "retry in Ns" number in the error message is a canned API hint that does NOT reflect the real daily-quota reset time (daily resets on UTC midnight).

**Revised lesson**: free-tier quota on `gemini-2.5-flash` is bounded by (RPM ∩ RPD). `--rpm-limit` only protects you from the RPM side; the RPD side will block Group 17 dogfood the moment you burn through the day's allowance, regardless of how slowly you pace calls. Today the budget was exhausted by (smoke test) + (3 dogfood attempts) + probably some earlier foundation testing.

**What to do next session**:
- If it is after UTC midnight, the RPD quota has reset and `--rpm-limit 5 --max-retries 0` should work for a single 25-step run (~125 calls when counting retries = 0). Avoid running the same dogfood twice in one day.
- If the quota is still exhausted: either (a) use a different API key / project, (b) upgrade to Gemini paid tier, or (c) try `--model gemini-2.5-flash-lite` or `--model gemini-2.0-flash-exp` which *may* have a separate RPD bucket (untested).
- Do NOT bother retrying with smaller RPM — it does not help once the daily bucket is gone.

### Path forward for Group 17.1 on the next session

1. Confirm no recent Gemini run in the last 2 minutes (`date` + cross-check any other process).
2. `rm -rf audit-output/settings-dogfood` (so JSONL writers start clean — they are append-only).
3. Run:
   ```bash
   node dist/index.js audit com.apple.Preferences \
     --runner xctest \
     --device 47C95D20-2AF0-424C-95EC-0FB20D090BB8 \
     --max-steps 25 \
     --model gemini-2.5-flash \
     --rpm-limit 5 \
     --max-retries 0 \
     --output-dir ./audit-output/settings-dogfood
   ```
4. Wall-clock budget to expect: ≥ 5 min of pacing + 5–7 s per AI call → plan for ~10–12 min. If a call still trips quota, `--rpm-limit 4` is the next step down; if *that* still trips, the run is gated on moving off free tier.
5. On success: manually review report.md against `dogfood-runbook.md` Gate C (FP rate target < 20 %). Then Maps (17.2) and Safari (17.3).

---

## 6 · Real bugs discovered during smoke (Phase 1.5 backlog)

These are **NOT regressions of the audit work itself** — they're issues in adjacent code or design that the smoke run surfaced. Record them here so the next session doesn't re-discover them.

### BUG-A · `xctest.ts` tapText fails on curly apostrophe

**Observed**:

```
Step 3 action: tapText("Don't have an Apple Account?")
⚠️  action failed: [XCTest] Element with text "Don't have an Apple Account?" not found
```

**Cause**: The element on screen uses the typographic curly apostrophe `’` (U+2019). The AI copied it verbatim from what it saw. XCTest's element search did **not** find it, probably because the element's stored name uses the ASCII apostrophe `'` (U+0027) or vice versa.

**Fix location**: `src/xctest.ts` — the `tapText` element lookup. Add Unicode NFKC normalization + try both `’` ↔ `'` fallbacks before failing.

**Severity**: Medium. Only affects text-tap actions whose target text has smart punctuation. Does not affect the audit loop correctness — the action failure was gracefully logged and the loop continued.

**Scope**: Phase 1.5 (not blocking Phase 1 merge if dogfood FP rate is still < 20%).

### BUG-B · Screen map uses fingerprint hex when AI omits the audit block — ✅ **FIXED in `540c37f` (2026-04-12)**

**Observed in** `/tmp/audit-smoke/report.md`:

```
## Screen Map
- Screen@e0d902ac
- Screen@259cccad
- Screen@e059af7f (2 visits)
```

**Cause**: `AuditExecutor.runLoop()` gets screen name from `result.audit?.screenName` which is inside the **optional** audit block. When AI correctly reports "no issues on this screen" and omits the audit block entirely, `screenName` falls through to `Screen@<fingerprint>` — that's what the report renders.

**Fix**: Move `screenName` out of the optional `audit` block in `src/schemas/audit.ts`. It should always be returned at the top level of `AuditDecision` (next to `navigation`, `reasoning`, `progress`, `onboardingDetected`) so the executor always gets a human-readable screen name regardless of issue presence.

**Estimated change**: ~15 LOC across `src/schemas/audit.ts`, `src/audit-agent.ts` (`toStepResult`), and `src/audit-executor.ts` (where it reads `result.audit?.screenName`).

**Severity**: Medium. Makes the screen map unreadable for any run that finds zero issues, which is exactly the kind of run we most want to demo. Worth fixing before continuing dogfood.

**Scope**: Phase 1 (fix before Group 17 dogfood) — this is small and the fix is obvious.

### OBSERVATION-C · Agent picks login-wall exploration paths on first screen — ✅ **FIXED in `540c37f` (2026-04-12)**

The agent on step 2–5 chose to navigate the Apple Account sign-in flow from the Settings app, which on a fresh simulator immediately hits a login wall (`Sign in Manually` → `Don't have an Apple Account?` → email field → `繼續`). This is not a bug, but it's a poor exploration strategy for a general-purpose audit: the agent got trapped in a flow it can't complete.

**Fix direction**: Strengthen the system prompt in `src/audit-agent.ts` `buildAuditSystemPrompt()` with an anti-pattern:

> Do NOT pursue account creation, login, or identity-verification flows during exploration unless they are the explicit audit scope. These flows terminate at walls the agent cannot cross without real credentials, wasting the remaining step budget. If you see a login gate on the first screen, back out and pick a different top-level entry point.

**Severity**: Medium. Directly impacts dogfood quality on Settings in particular. Worth fixing before the next dogfood round.

**Scope**: Phase 1 — ~10 lines in the prompt.

---

## 7 · Known-good commands

```bash
# Build
npm run build

# Type check
npx tsc --noEmit

# Unit tests (106 passing)
npm test

# Smoke audit — 5-step (~2 min, ~$0.001)
node dist/index.js audit com.apple.Preferences \
  --runner xctest \
  --device 47C95D20-2AF0-424C-95EC-0FB20D090BB8 \
  --max-steps 5 \
  --model gemini-2.5-flash \
  --rpm-limit 12 \
  --output-dir /tmp/audit-smoke

# Longer dogfood run (25 steps, Group 17 target)
node dist/index.js audit com.apple.Preferences \
  --runner xctest \
  --device 47C95D20-2AF0-424C-95EC-0FB20D090BB8 \
  --max-steps 25 \
  --model gemini-2.5-flash \
  --rpm-limit 12 \
  --output-dir ./audit-output/settings-dogfood

# CLI help
node dist/index.js audit --help

# Phase 1 scope gate verification
node dist/index.js audit com.apple.Preferences --ios-device abc  # should exit 1 with E_DRIVER_NOT_READY
node dist/index.js audit com.apple.Preferences --runner wda      # should exit 1 with E_DRIVER_NOT_READY
node dist/index.js audit com.apple.Preferences --hard-timeout 0  # should exit 1 with "must be ≥ 1000"
```

---

## 8 · Code patterns that were hard-won (don't re-derive)

### 8.1 Promise.race + AbortController for AI call timeout

`src/audit-agent.ts` `decideAudit()`. Three pieces wired together:
1. `abortController.signal` passed to both `generateObject` and the fallback `generateText`
2. `timedOut` synchronous flag set in the setTimeout handler before calling `abortController.abort()`
3. The inner aiCall must **short-circuit on `timedOut` before any state mutation** (fallbackStreak), otherwise the loser of the race can still mutate agent state asynchronously

The `aiCall.catch(() => {})` call right after `aiCall` is created prevents the unhandled rejection when timeout wins.

**If you refactor this, keep the three pieces together.** Codex flagged this as a High in the Group 8/9 review and the fix above was verified correct.

### 8.2 Stateless audit — the exploration state block IS the memory

Decision 11. AuditAgent **does not touch `this.conversationHistory`** from the parent TaskAgent. Every `decideAudit()` call is a single-turn message. All continuity comes from the `EXPLORATION STATE` text block injected into the user message: visited list (top-10), unvisited targets from the current tree, last 3 actions, phase, tree grade.

If you extend this, **don't reintroduce conversation history** — the token savings (~30 %) and reduced bias on per-screen analysis are both load-bearing for Phase 1 cost targets.

### 8.3 Tree parsed once per step

`parseAccessibilityTreeDetailed()` used to be called twice per step (once in `buildUserContent`, once in `toStepResult`). The `71fd904 refactor` fix parses once at the top of `decideAudit()` and flows the result through both. Don't re-duplicate.

### 8.4 `TaskExecutor` reuse surface

In order for `AuditExecutor extends TaskExecutor` to share driver lifecycle and `executeAction` without duplicating them, the following members are `protected` (not private):

- `maestro`, `agent` fields
- `waitForScreenStable`, `getPostActionDelay`, `executeAction`, `formatAction`

Plus `sleep` is `export`ed from `src/executor.ts`.

`run` mode's public behaviour is untouched — all changes were visibility-only.

### 8.5 Numeric CLI flag validation

`parseIntFlag(raw, fallback, flagName, { min, max? })` in `src/index.ts`. Used for every audit numeric flag to reject NaN, negative values, and out-of-range values (e.g., `livePort` max 65535) with a flag-named error message. Don't manually `parseInt` anything new without going through this.

### 8.6 Secret redaction in error output

`redactSecrets()` in `src/index.ts` scrubs Bearer tokens, `api_key=`, `AIza…` (Google), `sk-…` (OpenAI), and `key|token|secret=…` query params. Called by `formatAuditError` before printing any non-`AuditError` message. Added after Codex flagged it — **do not bypass it** when logging errors.

---

## 9 · Recent Codex reviews (what's been re-verified)

Every non-trivial commit on this branch was reviewed by Codex (`codex:codex-rescue`). All findings have been fixed and re-verified. The review reports live in `/tmp/codex-*.md` (local, not committed).

| Review | Commit | Findings | All fixed? |
|--------|--------|----------|------------|
| Foundation pass | `0786ea2` | 0 Critical · 2 High · 4 Minor | ✅ (`c26164e`) |
| Group 8 + 9 | `1deeb5f` | 0 Critical · 3 High · 1 Minor | ✅ (`1c4a833`) |
| Group 10–12 (simplify pass) | `06e089d` | 0 Critical · 4 Reuse · 4 Efficiency · 1 Quality | ✅ (`71fd904`) |
| Group 13 | `018bc80` | **not yet reviewed** | — |

**Next Codex review target**: `018bc80` (Markdown report renderer). The work itself is tested (106/106) and visually verified, but a second pair of eyes on the renderer hasn't happened yet.

---

## 10 · Open questions carrying across sessions

1. ~~**Screen name propagation** (BUG-B above).~~ ✅ Resolved in `540c37f`. `screenName` is now top-level required (`.min(1)`), fallback path reports `'(fallback)'`.

2. ~~**Onboarding detection** (OBSERVATION-C).~~ ✅ Resolved in `540c37f`. New `EXPLORATION ANTI-PATTERNS` prompt section covers login/sign-in/payment/identity-verification walls.

3. **Live viewer scope** (Group 14A). The spec says it's Phase 1 but nothing in the smoke test needs it. Candidate for Phase 1.5 downshift if schedule is tight. Decision 18 rationale (Bret Victor / Jonathan Lipps / Don Norman) argues for "always-on annotation, live viewer opt-in" — so the current state (annotation always, no live viewer) is already philosophically consistent.

4. **Run-mode regression** (Group 16). Not yet verified. Should do an end-to-end `phone-use run <bundle> <task>` before claiming Phase 1 done. Low risk (run code path is untouched) but deserves confirmation.

5. **`generateObject` deprecation warning**. TypeScript currently emits `★` hints that `generateObject` is deprecated in AI SDK v6. POC showed it still works and we use it everywhere. We deliberately deferred this. Phase 1 ships with it; Phase 2 may need to migrate to the replacement API when AI SDK makes one available with the same structured-output + vision guarantees.

---

## 11 · Quick decision checklist for the next session

Pick one. Don't thrash.

**Path A — Finish Phase 1 correctness** (recommended, but quota-gated)
1. ~~Fix BUG-B (screenName out of optional block)~~ — ✅ done in `540c37f`
2. ~~Strengthen prompt anti-pattern (login-wall avoidance)~~ — ✅ done in `540c37f`
3. Run a real 25-step dogfood audit of Settings (Group 17.1) — **see §5A for exact command and rate-limit settings**; the attempt on 2026-04-12 was killed by Gemini free-tier throttling after 5 steps. Either cool down ≥ 60 s and retry with `--rpm-limit 5 --max-retries 0`, or upgrade off free tier.
4. Manually review FP rate (Gate C of `dogfood-runbook.md`)
5. If FP rate < 20 %, tackle Maps (17.2) then Safari (17.3)

**Path B — Finish Phase 1 completeness** (unblocks while Gemini quota recovers)
1. Group 14.2–14.4 (async SIGINT finalize, already-mostly-done error format polish)
2. Group 16 (run-mode regression verification)
3. Group 19 (ops readiness — `.env.example`, CI workflow)
4. Then return to Path A

**Path C — Codex review first**
1. Run Codex review on `018bc80` (Group 13 report renderer) and `540c37f` (Phase 1.5 fixes)
2. Fix any findings
3. Then pick Path A or B

My recommendation (updated 2026-04-12): **Path A step 3 only** — the hard code work is already done, the blocker is purely rate-limit. If a cool-down + conservative rerun still trips quota, flip to Path B and come back to dogfood after switching off Gemini free tier.

---

## 12 · Don't repeat these design conversations

They've already been settled with scored evidence in `design.md`. If the next session starts re-opening any of these, point them at the relevant Decision:

- Structured output vs. free-form parse → Decision 1, scored 9.75
- FP control strategy → Decision 2, three-layer scored 9.25
- Exploration strategy → Decision 3, hybrid scored 9.25
- Stateless vs. conversation history → Decision 11, perfect 10/10
- Rate limiter design → Decision 19, scored 9.5
- Phase 1 simulator-only → Decision 20, scored 9.75 (based on real OPS-20 discovery that iOS 26 physical device has no runner)
- Annotation-always + live-viewer-opt-in → Decision 18, three-expert simulated debate

Re-opening any of these is a waste of budget unless there's new evidence the previous scoring didn't account for.

---

## 13 · Files to read first in the next session

In order of decreasing leverage:

1. **This file** (`handoff.md`) — you're reading it.
2. `openspec/changes/add-mobile-ux-audit/design.md` — 21 design decisions, POC findings, risks
3. `openspec/changes/add-mobile-ux-audit/tasks.md` — current task progress grid
4. `src/audit-agent.ts` — the brain; most design decisions land here
5. `src/audit-executor.ts` — the loop; rest of the decisions land here
6. `/tmp/audit-smoke/report.md` — the actual output of the first real run (if still present)
7. `openspec/changes/add-mobile-ux-audit/dogfood-runbook.md` — the 10-gate validation protocol for Group 17

Do NOT re-read:
- `src/agent.ts`, `src/executor.ts` — `run` mode, touched only for visibility changes
- `src/maestro.ts`, `src/wda.ts`, `src/xctest.ts` — unchanged driver clients
- `tests/*.test.ts` unless debugging a specific failure — they're stable

---

## 14 · One more thing

The progress tracking in `tasks.md` uses `- [x]` checkboxes. Keeping it in sync is easy:

```bash
python3 <<'PYEOF'
import re
path = 'openspec/changes/add-mobile-ux-audit/tasks.md'
with open(path) as f:
    content = f.read()
done_prefixes = ['X.Y', 'X.Z']  # list tasks to mark as done
for prefix in done_prefixes:
    content = re.sub(r'^- \[ \] ' + re.escape(prefix) + r' ', f'- [x] {prefix} ', content, flags=re.M)
with open(path, 'w') as f:
    f.write(content)
done = len(re.findall(r'^- \[x\] ', content, re.M))
pending = len(re.findall(r'^- \[ \] ', content, re.M))
print(f'tasks: {done} done, {pending} pending')
PYEOF
```

Use this after any group is finished. The `openspec status --change "add-mobile-ux-audit"` command will then reflect the new progress.

---

**End of handoff. You have everything you need. Start with §11 (Path A, BUG-B).**

---

## 9 · Sprint 1 — Report Quality Fixes (Phase 2)

**Branch**: `phase2-sprint1` (based on `main` which contains merged Phase 1)
**Goal**: Report quality from 2/10 → 6-7/10
**Date**: 2026-04-13

### Completed

| ID | Fix | Commit | LOC |
|----|-----|--------|-----|
| C1 | Real frame dimensions in tree output | `397f74f` | ~120 |
| C2 | `cognitiveImpact` field + GOOD/BAD examples | `c524072` | ~30 |
| C3 | Scope guard (cross-app drift detection) | `683eaef`, `755a743` | ~30 |
| H1 | Three-pass dedup (exact → fuzzy → cross-screen principle) | `b57718f`, `76f977e` | ~40 |
| H2 | Anti-patterns (modal, chrome, back button, font specimen) | `4cccd00`, `57d937f` | ~10 |
| H3 | Severity calibration rubric | `b2cedf2` | ~20 |
| P1 | Font specimen triple-layer defense | `38115c2` | ~40 |
| P3 | Consecutive swipe escape heuristic | `d31ec6f` | ~18 |

### In Progress

| ID | Fix | Status |
|----|-----|--------|
| P4 | Stuck escape → relaunch app | ✅ Done |
| P5 | Pre-audit step budget estimation | ✅ Done |
| V1 | Final dogfood verification | ✅ Done — 14 screens, 2 issues, 0 FP |

### Dogfood Results

| Run | Issues | False Positives | Key Finding |
|-----|--------|----------------|-------------|
| v1 (pre-fix) | 4 | 3 (75%) | Flagging iOS standard elements |
| v2 (C1-H3) | 13 | 10 (77%) | 8 duplicate font contrast issues |
| v3 (+ P1) | 5 | 4 (80%) | Font preview still leaking |
| v4 (+ P1 triple-layer) | 0 | 0 | Agent trapped in font subtree, never left |

### Design Decisions (from pre-mortem)

- **Relaunch over back**: stuck escape should relaunch app, not just go back one level
- **Step estimation before audit**: parse home screen tree to count sections × 3, show coverage %
- **Overview mode deferred**: pre-mortem identified scope creep risk; validate relaunch fix first
- **Multi-session exploration deferred**: needs validation that single-session coverage is insufficient
- **Deterministic replay navigation deferred**: path fragility risk identified in pre-mortem
