# Audit Error Codes

Every hard failure from `phone-use audit` surfaces as an `AuditError` with a
discriminated `code` and a short `hint`. The CLI formatter prints both and
links here — append `#<code-in-lowercase>` to the link to jump straight to
the section for the code you hit.

If you see a message like this in your terminal:

```
❌ Audit failed: E_DEVICE_LOCKED
   Screenshot failed after 3 retries. <driver error>
   Troubleshooting: docs/audit-errors.md#e_device_locked
```

scroll to the matching section below. Every entry follows the same shape:
**what it means**, **most common causes**, **what to try first**.

---

## e_driver_not_ready

**What it means**: the selected runner driver (`xctest` / `wda` / `maestro`)
failed to start, crashed, or stopped responding before the audit could
observe its first screen.

**Common causes**:
- Simulator not booted. `xctest` targets require a booted iOS 26 simulator
  whose UDID you pass via `--device`.
- `maestro-driver-ios` build cache is missing and the first-run Xcode build
  failed (look for compiler errors higher up in the output).
- `--xctestrun-path` points at a stale or deleted file.
- Phase 2 drivers (`wda` / `maestro` on a physical device) were requested.
  Phase 1 rejects these up front — see §20 of `design.md`.

**Try first**:
1. Run `xcrun simctl list devices booted` — make sure your `--device` UDID
   appears as `Booted`.
2. If `xctest` cannot find an `.xctestrun`, delete `/tmp/maestro-driver-build`
   and let the next audit rebuild it.
3. Confirm you are running on iOS 26 (Phase 1 scope). iOS 18.x simulators
   are not supported by the audit command.

---

## e_app_not_installed

**What it means**: the driver started, but launching `<bundleId>` returned
"not found" or the app failed to come to the foreground within the launch
window.

**Common causes**:
- Typo in `<bundleId>` (e.g. `com.apple.Preferences` vs `com.apple.preferences`).
- The app is not installed on the target simulator.
- Device is still decrypting / post-erase and refuses launches.

**Try first**:
1. `xcrun simctl listapps <device-udid> | grep -i <bundleId>`
2. Install or reinstall the app, then rerun the audit.
3. If you are attaching to a pre-authenticated state, pass `--skip-launch`
   so the audit reuses the foreground app instead of launching it.

---

## e_model_incompatible

**What it means**: `generateObject()` returned `NoObjectGeneratedError` three
consecutive times. The current model cannot reliably produce structured
output for vision + Zod schema on this app.

**Common causes**:
- Using a non-vision model (`--model gpt-4o-mini-text`, etc.).
- A brand-new model whose AI SDK provider does not yet support
  constrained decoding with images.
- The prompt or schema is too long for the model's output budget (rare,
  only seen on smaller models).

**Try first**:
1. Switch to a known-good model: `--model gemini-2.5-flash` or
   `--model gpt-4o`.
2. If you *need* the new model, file an issue and attach the partial
   `report.md` — the fallback path still produces evidence of the failure.

---

## e_network_timeout

**What it means**: a single AI call exceeded `--hard-timeout` (default 45 s).
The `AbortController` aborted the in-flight request and the audit stopped
the step with a partial report.

**Common causes**:
- Cold provider region or temporary congestion.
- Very large accessibility trees that push the prompt over the provider's
  decode budget.
- Free-tier quota throttling that the rate limiter could not fully absorb.

**Try first**:
1. Rerun with `--hard-timeout 90000` if you think the call was about to
   succeed.
2. Lower `--rpm-limit` if you suspect rate-limiter pressure.
3. If you are on Gemini free tier and the first call of the run times out,
   you may actually be out of daily quota — check `handoff.md` §4 for the
   symptoms and wait for the UTC-midnight reset or upgrade tier.

---

## e_device_locked

**What it means**: screenshots failed three times in a row while the driver
itself still appeared alive. Usually the device is showing the lock screen,
a system modal, or Face ID prompt that blocks the audit's screen capture.

**Common causes**:
- Simulator auto-locked during a long run.
- A system dialog (passcode, Face ID, system update) took over the screen.
- Physical device (Phase 2) went to sleep.

**Try first**:
1. Click the simulator window and dismiss any modal.
2. Disable auto-lock on the simulator: Settings → Display & Brightness →
   Auto-Lock → Never.
3. Rerun the audit.

---

## e_app_crashed

**What it means**: the target `<bundleId>` was not in the foreground for
two consecutive steps. Either the app crashed, it sent the user back to
Springboard, or navigation exited the app.

**Common causes**:
- A real crash in the app — check Console.app for a matching log.
- The agent tapped `back` enough times to exit the app.
- The agent opened an external link that left the app.

**Try first**:
1. Rerun without the crashing screen — add `--scope "feature area"` to
   steer the agent away from the problem path.
2. Check the partial `report.md` for the last step before the crash; the
   annotated screenshot usually makes the trigger obvious.
3. If the cause is external-link drift, strengthen the anti-pattern list
   in the audit prompt (see `src/audit-agent.ts` `buildAuditSystemPrompt`).

---

## e_budget_exceeded

**What it means**: total input tokens for the run crossed `--token-budget`
(default 200 000) before `--max-steps` was reached. The audit stopped early
to protect your bill.

**Common causes**:
- Very verbose screens inflating the accessibility tree on every step.
- A stuck loop re-sending similar screens.
- `--max-steps` set higher than the budget realistically supports.

**Try first**:
1. Raise `--token-budget` if you know what you're paying for.
2. Lower `--max-steps` to match the budget you do want.
3. Narrow the run with `--scope` so the agent stops wandering.

---

## e_user_aborted

**What it means**: you pressed Ctrl+C and the audit cancelled gracefully.
The runner finished the current step, wrote a partial `report.md`, and then
exited with this code. A second Ctrl+C force-quits without finalization.

**What to do**:
1. Open the partial report — it contains every step the audit got through
   plus a banner that says the run ended early.
2. Rerun when you are ready; nothing is broken.

---

## e_concurrent_run

**What it means**: another audit process already holds the per-device
lockfile at `/tmp/phone-use-audit-<device-id>.lock`. Two audits against the
same device at the same time would corrupt the shared output dir.

**Try first**:
1. Check `ps aux | grep phone-use` to find the other process.
2. If the other process is long-dead, delete the stale lockfile by hand:
   `rm /tmp/phone-use-audit-<device-id>.lock`.
3. Rerun.
