# Phase 1 Dogfood Runbook

Step-by-step runbook for validating the mobile UX audit feature after implementation completes and before merging `feature/mobile-ux-audit` to `main`.

This is a **one-off operational document**, not a reusable skill. It encodes the decisions from the pre-mortems (PM-1..PM-30) and OPS checks (OPS-1..OPS-20) into a concrete execution sequence.

---

## 0 · Preflight (do this once, ~5 min)

All checks must pass before proceeding. Any red flag → stop and fix before running audit.

```bash
# Environment
node --version                                                          # expect >=18
sw_vers | grep ProductVersion                                           # expect 26.x
xcrun simctl list devices booted                                        # expect 1 booted iPhone on iOS 26
ls /Applications/Xcode-26.3.0.app >/dev/null && echo "Xcode 26.3 ok"

# API key (redacted check — do NOT print the value)
test -n "$GOOGLE_GENERATIVE_AI_API_KEY" && echo "gemini key: set" || echo "gemini key: MISSING"

# Build
cd /Users/justinlee/dev/phone-use
npm ci
npx tsc --noEmit                                                        # must pass
npm test                                                                # node:test unit suite must pass
npm run build                                                           # tsup → dist/

# Disk space for output
df -h /tmp | tail -1                                                    # need ≥ 100 MB headroom
```

**Gate A**: `tsc --noEmit` clean, `npm test` all green, simulator booted, API key set.

---

## 1 · Run-mode regression check (~2 min)

Before touching audit, prove the existing `run` command still works identically. Run the same LINE example from `CLAUDE.md` on the simulator:

```bash
# Pick any simple task the previous release handled
node dist/index.js run com.apple.Preferences \
  --runner xctest \
  --device $(xcrun simctl list devices booted -j | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(iter(next(iter(d["devices"].values())) ))["udid"])') \
  --max-steps 10 \
  --model gemini-2.5-flash \
  --task "Open the Wi-Fi settings and report whether it's on or off."
```

**Gate B**: Exits with `✅ SUCCESS`, behavior indistinguishable from the previous release (same prompts, same action formats, same output).

If anything differs → `run` mode regressed. Stop and fix before Phase 1 dogfood.

---

## 2 · Audit dogfood — three apps on iOS 26 simulator

Run the three Phase 1 targets in order. Save every report under `./audit-output/phase1/`.

```bash
export OUT=./audit-output/phase1
export SIM=$(xcrun simctl list devices booted -j | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(iter(next(iter(d["devices"].values())) ))["udid"])')
mkdir -p $OUT
```

### 2.1 · Rich tree target — Settings

```bash
node dist/index.js audit com.apple.Preferences \
  --runner xctest \
  --device $SIM \
  --max-steps 25 \
  --model gemini-2.5-flash \
  --rpm-limit 12 \
  --output-dir $OUT/settings \
  --live
```

Open the live viewer in browser (`http://localhost:7330`) while it runs. Watch the first 5 steps live to sanity-check:
- Annotated screenshot renders with clear tap circle + Action/Target/Why card
- Agent correctly identifies labels from the accessibility tree
- Exploration state block shows visited map growing
- Rate limiter `⏸` message appears at least once (proves it's wired)

**Acceptance per spec** (see `specs/ux-audit/spec.md`):
- [ ] Parse success rate ≥ 98 % (count `NoObjectGeneratedError` in `steps.jsonl` → should be 0 or 1)
- [ ] ≥ 8 distinct fingerprints in `visitedScreens` (Settings has plenty of screens)
- [ ] Per-step median ≤ 12 s
- [ ] Total wall-clock ≤ 6 min
- [ ] `timings.json` exists and contains 25 records
- [ ] `annotated/step-01.jpg` through `step-25.jpg` all exist
- [ ] `report.md` rendered with header, severity table, issue sections, screen map, performance table, next-steps

### 2.2 · Sparse tree target — Maps

```bash
node dist/index.js audit com.apple.Maps \
  --runner xctest \
  --device $SIM \
  --max-steps 20 \
  --model gemini-2.5-flash \
  --rpm-limit 12 \
  --output-dir $OUT/maps
```

**Acceptance**:
- [ ] Tree grade shows `sparse` or `empty` in `steps.jsonl` for most steps (confirms fallback path)
- [ ] Fingerprint is not all-zeros or all-identical (perceptual hash works)
- [ ] At least 3 distinct fingerprints (audit didn't just stare at the map canvas)
- [ ] Parse success rate ≥ 95 % (slightly lower bar because sparse tree is harder)

### 2.3 · WebView target — Safari

```bash
node dist/index.js audit com.apple.mobilesafari \
  --runner xctest \
  --device $SIM \
  --max-steps 15 \
  --model gemini-2.5-flash \
  --rpm-limit 12 \
  --output-dir $OUT/safari
```

**Acceptance**:
- [ ] Runs to completion without `E_MODEL_INCOMPATIBLE` or infinite loops
- [ ] Tree grade predominantly `empty` (confirms visual-only mode works)
- [ ] Report still renders — even with zero issues, the structure must be valid

---

## 3 · False-positive review (~20 min per report)

Open each `report.md` and annotate every issue with one of: `TP` (true positive), `FP` (false positive), `borderline`.

Use this shared checklist in a temp spreadsheet or `dogfood-review.md`:

| App | Issue ID | Severity | AI claim | Verdict | Notes |
|-----|----------|----------|----------|---------|-------|
| Settings | ISSUE-001 | High | ... | TP/FP/borderline | ... |

Rules:
- An issue is **FP** if the AI's evidence is wrong, the claim violates nothing, or the issue is standard iOS UI (`Decision 17` anti-patterns should have caught these).
- An issue is **borderline** if a reasonable reviewer could disagree. Count as 0.5 FP.
- An issue is **TP** if the AI correctly identified a real problem, even if minor.

Compute:
```
FP rate = (FP count + 0.5 × borderline count) / total issues
```

**Gate C**: FP rate < 20 % across all three reports combined.

If FP rate ≥ 20 %:
1. Do NOT merge
2. Identify the dominant FP pattern (e.g., "AI keeps flagging tab bar as confusing")
3. Add a specific anti-pattern line to `AuditAgent.buildSystemPrompt()` covering that pattern
4. Re-run the specific app(s) where that pattern dominated
5. Re-measure, iterate until < 20 %

---

## 4 · Performance & cost reality check

For each run, open `timings.json` and confirm:

```bash
for run in $OUT/settings $OUT/maps $OUT/safari; do
  echo "=== $run ==="
  node -e "const t=require('$run/timings.json'); 
    console.log('steps:', t.steps);
    console.log('p50 total:', t.total?.p50, 'ms');
    console.log('p95 total:', t.total?.p95, 'ms');
    console.log('total tokens in:', t.tokens?.input);
    console.log('total tokens out:', t.tokens?.output);
    console.log('est cost:', t.cost);"
done
```

**Gate D**:
- P50 total per step ≤ 12 000 ms
- P95 total per step ≤ 20 000 ms
- Total tokens per run ≤ 150 000 (should be much lower with prompt caching)
- Per-run cost (Gemini Flash) ≤ $0.05 — POC measured $0.003, so anything above $0.01 suggests caching regressed

---

## 5 · Edge case spot checks

Manual ~5 minute verification that error paths work:

### 5.1 · SIGINT partial report

```bash
node dist/index.js audit com.apple.Preferences \
  --runner xctest --device $SIM --max-steps 25 \
  --output-dir $OUT/sigint-test
# After step 5 or so, press Ctrl+C
```

**Acceptance**:
- [ ] Console prints shutdown + "writing partial report"
- [ ] `$OUT/sigint-test/report.md` exists with a "Partial report" banner
- [ ] `steps.jsonl` contains exactly the steps that ran before the interrupt
- [ ] `AuditError` code `E_USER_ABORTED` appears in the banner

### 5.2 · Concurrent lock

```bash
# Terminal 1
node dist/index.js audit com.apple.Preferences --runner xctest --device $SIM --max-steps 25 --output-dir $OUT/lock-1 &

# Terminal 2 (immediately)
node dist/index.js audit com.apple.Preferences --runner xctest --device $SIM --max-steps 25 --output-dir $OUT/lock-2
```

**Acceptance**:
- [ ] Terminal 2 exits immediately with `E_CONCURRENT_RUN` and the PID of terminal 1
- [ ] Terminal 1 finishes normally
- [ ] Lockfile `/tmp/phone-use-audit-<sim-udid>.lock` removed after terminal 1 exits

### 5.3 · Model incompatibility (simulated)

```bash
# Force failure by requesting an invalid model
node dist/index.js audit com.apple.Preferences \
  --runner xctest --device $SIM --max-steps 5 \
  --model gemini-nonexistent-model \
  --output-dir $OUT/bad-model
```

**Acceptance**:
- [ ] Exits with `AuditError` code `E_MODEL_INCOMPATIBLE` (or similar documented code) within ≤ 60 s
- [ ] Error message includes the model suggestion from the taxonomy
- [ ] No raw stack trace unless `DEBUG=1`

---

## 6 · Release gate decision

Only merge `feature/mobile-ux-audit` to `main` if ALL of these are true:

| Gate | Status |
|------|--------|
| A — Preflight clean | [ ] |
| B — Run mode not regressed | [ ] |
| 2.1 — Settings acceptance criteria met | [ ] |
| 2.2 — Maps acceptance criteria met | [ ] |
| 2.3 — Safari acceptance criteria met | [ ] |
| C — FP rate < 20 % across all three | [ ] |
| D — Performance & cost budgets met | [ ] |
| 5.1 — SIGINT partial report works | [ ] |
| 5.2 — Concurrent lock works | [ ] |
| 5.3 — Model error has taxonomy code | [ ] |

**If any unchecked → no merge.** Fix the specific failure, re-run only the affected step, re-check.

---

## 7 · Post-merge followups (Phase 1.5 backlog)

Issues discovered during dogfood but NOT blocking merge should be added to a `phase-1-5-followups.md` file in this change folder, then promoted to a new openspec change proposal after merge. Typical candidates:

- Rate limiter tuning (if default 12 RPM is too conservative or too aggressive)
- Specific anti-pattern additions that didn't quite land in Phase 1
- Cost regressions if Gemini pricing changes
- Simulator-specific quirks the AI struggled with
- Better "how to verify the fix" snippets

Do NOT silently tweak the main codebase after merge — every follow-up goes through the openspec workflow so the design decisions stay documented.

---

## Appendix · Quick reference

**Kill a stuck audit**:
```bash
# Find the process
pgrep -f "dist/index.js audit"
# Kill it
kill -TERM <pid>      # gives it a chance to write partial report
# or
kill -9 <pid>         # hard kill (JSONL still recoverable)
```

**Manually rebuild report from JSONL** (if audit crashed before finalize):
```bash
node -e "const { finalizeReport } = require('./dist/audit-report.js'); finalizeReport('./audit-output/phase1/settings').then(()=>console.log('ok'))"
```

**Clear stuck lockfile**:
```bash
rm -f /tmp/phone-use-audit-*.lock
```

**Watch live timing data**:
```bash
tail -f ./audit-output/phase1/settings/steps.jsonl | jq '{step, action, ai_ms: .timing.ai_ms, tokens: .timing.input_tokens}'
```
