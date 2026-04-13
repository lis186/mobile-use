/**
 * AuditAgent — the vision-model brain of an audit run.
 *
 * Extends TaskAgent to reuse the provider setup, image optimisation, and
 * stuck-pattern warnings. Overrides `decide()` with a completely different
 * shape:
 *   - stateless (no conversation history — every call is single-turn)
 *   - structured output via `generateObject()` + Zod schema
 *   - rate-limited + hard-timeout wrapped
 *   - confidence-filter + fallback-streak tracking
 *
 * This file is wired into AuditExecutor in Groups 10-12.
 */

import { generateObject, generateText, NoObjectGeneratedError } from 'ai';
import { optimizeScreenshot } from './core/image-utils.js';
import { TaskAgent } from './agent.js';
import { auditDecisionSchema, type AuditDecision } from './schemas/audit.js';
import { AuditError } from './errors/audit-errors.js';
import { GeminiRateLimiter } from './core/rate-limiter.js';
import {
  parseAccessibilityTreeDetailed,
  extractNavTargets,
  type ParsedTree,
} from './core/tree-parser.js';
import type { AuditConfig, TreeQuality, VisitedScreen, AgentDecision } from './types.js';

/** Narrow user-message content type: either text or an inline image buffer. */
type UserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: Buffer };

/** Context the executor passes in per step (state lives there, not in the agent). */
export interface AuditAgentContext {
  stepNumber: number;
  totalSteps: number;
  screenshotBuffer: Buffer;
  accessibilityTree?: string;
  visited: Map<string, VisitedScreen>;
  unvisitedTargets: string[];
  recentActions: string[];
  scope?: string;
}

/** Decision returned to the executor. Plain types only — no Zod objects leak out. */
export interface AuditStepResult {
  /** The navigation action in run-mode shape (so the existing executeAction switch works). */
  navigation: AgentDecision;
  /** Human-readable screen name — always present, independent of whether issues were found. */
  screenName: string;
  /** The raw structured audit block (may be undefined on a clean screen). */
  audit?: AuditDecision['audit'];
  reasoning: string;
  progress: number;
  onboardingDetected: boolean;
  /** Parsed tree + grade used this step (executor reuses for fingerprint). */
  parsedTree?: ParsedTree;
  /** Token usage for this step, pushed into StepTiming by the executor. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
  };
  /** True when the call went through the degraded generateText fallback path. */
  usedFallback: boolean;
}

// ── Constants tuned from POC findings and pre-mortem decisions ──────

const MAX_FALLBACK_STREAK = 3;  // Decision 14
const CONFIDENCE_THRESHOLD = 60;  // Decision 17
const VISITED_TOP_K = 10;  // Decision 17 — prompt length bound
const MAX_RECENT_ACTIONS = 3;  // Decision 11 — the state block IS the memory

export class AuditAgent extends TaskAgent {
  private readonly auditConfig: AuditConfig;
  private readonly rateLimiter: GeminiRateLimiter;
  private fallbackStreak = 0;

  constructor(
    apiKey: string,
    config: AuditConfig,
    provider: 'google' | 'openai' = 'google',
    rateLimiterLog?: (msg: string) => void,
  ) {
    super(apiKey, config.model, provider);
    this.auditConfig = config;
    this.rateLimiter = new GeminiRateLimiter({
      rpmLimit: config.rpmLimit,
      log: rateLimiterLog,
    });
  }

  /**
   * Single-turn stateless decide. NO use of this.conversationHistory.
   * Throws AuditError on hard failures; returns AuditStepResult on success
   * (including the degraded fallback path).
   */
  async decideAudit(ctx: AuditAgentContext): Promise<AuditStepResult> {
    // Parse the tree ONCE per step and flow it through both buildUserContent
    // (for the prompt tree block) and toStepResult (so the executor can reuse
    // it for fingerprinting and nav-target extraction). Previously this was
    // called twice per step.
    const parsedTree = ctx.accessibilityTree
      ? parseAccessibilityTreeDetailed(ctx.accessibilityTree)
      : null;

    const systemPrompt = this.buildAuditSystemPrompt();
    const userContent = await this.buildUserContent(ctx, parsedTree);

    await this.rateLimiter.acquire();

    // AbortController cancels the in-flight AI call when the hard timeout
    // fires. Without this, the loser of Promise.race would keep running in
    // the background, burn tokens, and mutate fallbackStreak after the
    // caller already saw E_NETWORK_TIMEOUT (the race leak Codex flagged).
    const abortController = new AbortController();

    // Set synchronously in the race so the aiCall coroutine can see it
    // even if it resumes between microtasks after the timeout has fired.
    let timedOut = false;

    const aiCall = (async () => {
      try {
        const result = await generateObject({
          model: this.getModel(),
          system: systemPrompt,
          messages: [{ role: 'user', content: userContent }],
          schema: auditDecisionSchema,
          maxRetries: this.auditConfig.maxRetries,
          abortSignal: abortController.signal,
        });
        // If the race already resolved via timeout, drop the result silently.
        if (timedOut) throw new Error('aborted');
        this.fallbackStreak = 0;
        return this.toStepResult(result.object, result.usage, false, parsedTree);
      } catch (err) {
        // After timeout, the aiCall must NOT mutate state or throw anything
        // other than an already-settled marker. Short-circuit here.
        if (timedOut) throw new Error('aborted');
        // Abort signalled from the timeout path — leave fallbackStreak alone.
        if (isAbortError(err)) throw new Error('aborted');
        if (err instanceof NoObjectGeneratedError) {
          this.fallbackStreak++;
          if (this.fallbackStreak >= MAX_FALLBACK_STREAK) {
            throw new AuditError(
              'E_MODEL_INCOMPATIBLE',
              `generateObject() failed ${MAX_FALLBACK_STREAK} consecutive times. The current model (${this.auditConfig.model}) may not support structured output with vision. Try --model gemini-2.5-flash or gpt-4o.`,
              { cause: err },
            );
          }
          // Degraded path: take just a navigation action so the step isn't wasted.
          return await this.fallbackNavOnly(parsedTree, userContent, systemPrompt, abortController.signal);
        }
        throw err;
      }
    })();
    // Prevent an unhandled rejection from the losing side of the race
    // after we've already surfaced the timeout to the caller.
    aiCall.catch(() => { /* swallowed: timeout path handles the error */ });

    const timeoutMs = this.auditConfig.hardTimeout;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<AuditStepResult>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        abortController.abort();
        reject(
          new AuditError(
            'E_NETWORK_TIMEOUT',
            `Single audit call exceeded ${(timeoutMs / 1000).toFixed(0)}s. Consider upgrading Gemini tier or reducing --max-steps.`,
          ),
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([aiCall, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  /** Expose the rate limiter so the executor can read its remaining budget if needed. */
  getRateLimiter(): GeminiRateLimiter {
    return this.rateLimiter;
  }

  // ── Private helpers ────────────────────────────────────────────

  /** Convert a validated AuditDecision into the executor-facing step result. */
  private toStepResult(
    obj: AuditDecision,
    usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } & Record<string, unknown>,
    usedFallback: boolean,
    parsedTree: ParsedTree | null,
  ): AuditStepResult {
    // Map audit schema's navigation to the executor's AgentDecision shape
    const nav = obj.navigation;
    const agentDecision: AgentDecision = {
      action: nav.action,
      params: {
        ...(nav.x !== undefined ? { x: nav.x } : {}),
        ...(nav.y !== undefined ? { y: nav.y } : {}),
        ...(nav.text !== undefined ? { text: nav.text } : {}),
        ...(nav.startX !== undefined ? { startX: nav.startX } : {}),
        ...(nav.startY !== undefined ? { startY: nav.startY } : {}),
        ...(nav.endX !== undefined ? { endX: nav.endX } : {}),
        ...(nav.endY !== undefined ? { endY: nav.endY } : {}),
        ...(nav.url !== undefined ? { url: nav.url } : {}),
        ...(nav.key !== undefined ? { key: nav.key } : {}),
        ...(nav.appId !== undefined ? { appId: nav.appId } : {}),
      },
      reasoning: obj.reasoning,
      progress: obj.progress,
    };

    // Filter out low-confidence issues per Decision 17
    const auditBlock = obj.audit
      ? {
          issues: obj.audit.issues.filter((i) => i.confidence >= CONFIDENCE_THRESHOLD),
        }
      : undefined;

    return {
      navigation: agentDecision,
      screenName: obj.screenName,
      audit: auditBlock,
      reasoning: obj.reasoning,
      progress: obj.progress,
      onboardingDetected: obj.onboardingDetected === true,
      parsedTree: parsedTree ?? undefined,
      usage: {
        inputTokens: Number(usage?.inputTokens ?? 0),
        outputTokens: Number(usage?.outputTokens ?? 0),
        cachedTokens: Number(usage?.cachedInputTokens ?? 0),
      },
      usedFallback,
    };
  }

  /**
   * Degraded fallback: the model couldn't produce structured output this step,
   * but we still want navigation so the run isn't wasted. Use generateText with
   * a minimal nav-only prompt, parse the first JSON blob.
   */
  private async fallbackNavOnly(
    parsedTree: ParsedTree | null,
    userContent: UserContentPart[],
    _systemPrompt: string,
    abortSignal?: AbortSignal,
  ): Promise<AuditStepResult> {
    const minimalSystem = `You are a mobile navigation agent. Respond with ONLY a JSON object: { "action": "tap" | "tapText" | "scroll" | "back" | "done", "target": "brief description", "text": "exact text to tap", "reasoning": "one sentence" }. No markdown, no prose.`;

    const response = await generateText({
      model: this.getModel(),
      system: minimalSystem,
      messages: [{ role: 'user', content: userContent as UserContentPart[] }],
      maxRetries: this.auditConfig.maxRetries,
      abortSignal,
    });

    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? (safeJsonParse(jsonMatch[0]) as Record<string, unknown>) : null;

    const action = (parsed?.action as AgentDecision['action']) ?? 'wait';
    const text = parsed?.text as string | undefined;
    const target = (parsed?.target as string) ?? '(fallback)';
    const reasoning = (parsed?.reasoning as string) ?? 'Fallback navigation (structured output unavailable)';

    const agentDecision: AgentDecision = {
      action,
      params: text ? { text } : {},
      reasoning,
      progress: 0,
    };

    return {
      navigation: agentDecision,
      screenName: '(fallback)',
      audit: undefined,  // no audit analysis in fallback mode
      reasoning: `[FALLBACK] ${reasoning} (target: ${target})`,
      progress: 0,
      onboardingDetected: false,
      parsedTree: parsedTree ?? undefined,
      usage: {
        inputTokens: Number(response.usage?.inputTokens ?? 0),
        outputTokens: Number(response.usage?.outputTokens ?? 0),
        cachedTokens: Number(response.usage?.cachedInputTokens ?? 0),
      },
      usedFallback: true,
    };
  }

  /** Build the per-step user message: image + tree block + exploration state. */
  private async buildUserContent(
    ctx: AuditAgentContext,
    parsed: ParsedTree | null,
  ): Promise<UserContentPart[]> {
    const imageBuffer = await optimizeScreenshot(ctx.screenshotBuffer);

    const treeBlock = buildTreeBlock(parsed);
    const stateBlock = this.buildExplorationStateBlock(ctx, parsed?.grade ?? 'empty');

    return [
      { type: 'image', image: imageBuffer },
      { type: 'text', text: treeBlock },
      { type: 'text', text: stateBlock },
      { type: 'text', text: 'Analyze this screen and return a structured decision per the schema.' },
    ];
  }

  /** The exploration state block IS the memory — everything the agent needs. */
  private buildExplorationStateBlock(ctx: AuditAgentContext, grade: TreeQuality): string {
    const visited = [...ctx.visited.values()].sort((a, b) => b.count - a.count);
    const top = visited.slice(0, VISITED_TOP_K);
    const overflow = Math.max(0, visited.length - VISITED_TOP_K);
    const visitedLine =
      top.length > 0
        ? top.map((v) => `${v.name} (${v.count}x)`).join(', ') +
          (overflow > 0 ? `, ... +${overflow} more` : '')
        : '(none yet — this is the first screen)';

    const unvisited =
      ctx.unvisitedTargets.length > 0
        ? ctx.unvisitedTargets.slice(0, 12).join(', ')
        : '(no navigation targets detected in current tree)';

    const recent =
      ctx.recentActions.length > 0
        ? ctx.recentActions.slice(-MAX_RECENT_ACTIONS).join(' → ')
        : '(none yet)';

    const phase = phaseFor(ctx.stepNumber, ctx.totalSteps);
    const scopeLine = ctx.scope ? `Audit scope: ${ctx.scope}\n` : '';

    return `EXPLORATION STATE:
- Visited: ${visitedLine}
- Unvisited nav targets from tree: ${unvisited}
- Last ${MAX_RECENT_ACTIONS} actions: ${recent}
- Phase: ${phase} (step ${ctx.stepNumber}/${ctx.totalSteps})
- Accessibility data: ${grade}
${scopeLine}
STRATEGY: Visit unvisited areas FIRST. Do not re-enter an already-visited screen unless exploring a genuinely new sub-page.`;
  }

  /** Full audit-mode system prompt: Norman/Nielsen + HIG anchoring + anti-patterns + GOOD/BAD examples. */
  private buildAuditSystemPrompt(): string {
    const lang = this.auditConfig.language
      ? `\nLANGUAGE: The app UI is in ${this.auditConfig.language}. Use exact visible text for tapText actions.\n`
      : '';

    return `You are an autonomous mobile UX auditor. Your job is to explore a mobile app AND assess its UX on every screen you visit.
${lang}
ON EVERY STEP YOU MUST:
1. Decide the next navigation action to advance exploration
2. Report ONLY real UX issues on the current screen (omit the audit block if none)
3. Tag onboarding/tutorial screens so they can be excluded from coverage

== UX ANALYSIS FRAMEWORK ==
Apply Don Norman's principles (Affordance, Signifier, Feedback, Mapping, Constraints) and Jakob Nielsen's heuristics (Visibility of system status, Recognition over recall, Error prevention, Consistency, User control).

== iOS HUMAN INTERFACE GUIDELINES (compare against) ==
- Minimum tap target: 44 × 44 points
- Text contrast: ≥ 4.5:1 for normal text, ≥ 3:1 for large text or UI components
- Minimum system font size: 11 pt
- Standard platform navigation (tab bar, back button, modal sheet) is CORRECT, not confusing

== SEVERITY RUBRIC (use these rules consistently) ==
- **High**: blocks task completion, causes data loss, or completely prevents access to a feature
- **Medium**: causes measurable friction — tap target < 34pt on either axis, contrast < 3:1, error state with no recovery path, critical information hidden behind unnecessary interaction
- **Low**: minor friction — tap target 34–43pt (close but below 44pt minimum), contrast 3:1–4.5:1 for body text, cosmetic inconsistency that doesn't impede task completion
Do NOT assign severity by gut feeling. Use the measured values from the accessibility tree to determine the correct bucket.

== THREE-LAYER QUALITY CONTROL ==

Layer 1 — EVIDENCE REQUIRED: every issue MUST cite concrete visual facts from the accessibility tree data above. Each element line includes actual dimensions (e.g. "44×44pt"). Use ONLY these real measurements — NEVER estimate or guess sizes. If the tree provides "28×28pt" for a button, cite that exact number. Vague impressions ("feels cluttered") or made-up measurements ("approximately 22.5pt") are NOT acceptable.

Layer 2 — COMPARATIVE ANCHORING: compare against iOS HIG numbers above. Don't flag issues that meet the standard.

Layer 3 — ANTI-PATTERNS — NEVER report these:
- Standard iOS tab bar as "confusing"
- Back button position (it is standard, not a UX issue)
- Standard loading spinners as "poor feedback"
- Normal modal sheets as "intrusive"
- Standard button styles as "lacking affordance" (iOS buttons are blue; that IS the affordance)
- Information density that's appropriate for the app's domain
- iOS search bar / Spotlight field co-existing with a search button — this is the standard Settings pattern, not a "redundant search" issue
- iOS modal sheets that can be dismissed by swiping down — standard iOS behaviour per HIG; do NOT flag the absence of an explicit Done/Close button as a UX issue
- Accessibility-tree elements that are standard iOS system UI chrome (status bar, home indicator, system clock, battery, signal) are not actionable UX issues
- Standard iOS share sheets, action sheets, and activity views — these are system-provided components, not custom UX
- Duplicate of an issue you already reported on an earlier step for the same screen element — if you already flagged it, do not flag it again even if you revisit the screen

== GOOD vs BAD issue examples ==

GOOD issue (specific, measurable, causal reasoning):
{
  "title": "Search icon too small to tap reliably",
  "severity": "high",
  "principle": "iOS HIG:Tap Target",
  "cognitiveMechanism": "The small hit area forces fine motor precision under Fitts's Law. A rushed user with a thumb-based grip will miss repeatedly, triggering frustration and perceived app sluggishness.",
  "evidence": "Search icon (tree: 20×20pt) is below the 44×44pt minimum. Adjacent edit button is 28pt away.",
  "measured_width_pt": 20,
  "measured_height_pt": 20,
  "confidence": 85,
  "recommendation": "Extend hit area to 44x44pt using extendedEdgeInsets; alternative: move search to a dedicated row below nav bar"
}

BAD issue #1 (reject — shallow label, no causal reasoning):
{
  "title": "Inconsistent button style",
  "principle": "Nielsen:Consistency",
  "cognitiveMechanism": "This violates Nielsen's consistency heuristic.",
  "evidence": "Buttons look different on this screen."
}
→ WHY it's bad: cognitiveMechanism just restates the principle tag. It must explain WHAT the user experiences: e.g. "The user builds a mental model that rounded blue elements are tappable, then encounters a flat gray button and skips it because it doesn't match, creating a gulf of evaluation."

BAD issue #2 (reject — too vague, no evidence, violates anti-patterns):
{
  "title": "Navigation is confusing",
  "severity": "medium",
  "principle": "Nielsen:Consistency",
  "cognitiveMechanism": "Users might get confused.",
  "evidence": "The app feels hard to navigate.",
  "confidence": 50,
  "recommendation": "Redesign navigation"
}

== SYSTEM DIALOGS ==
If you see an iOS permission dialog (camera, location, notifications, Face ID), tap the most permissive safe action (Allow / OK / Later) to dismiss it. Do NOT report system dialogs as UX issues.

== ONBOARDING ==
If you see a tutorial, walkthrough, welcome screen, or "What's New" dialog, tap Skip / Got it / Continue to dismiss it. Set onboardingDetected=true so it's excluded from coverage.

== EXPLORATION ANTI-PATTERNS (avoid these traps) ==
- Do NOT pursue account creation, sign-in, login, or identity-verification flows (Apple Account, email verification, 2FA, password reset) unless they are the explicit audit scope. These flows terminate at walls the agent cannot cross without real credentials, wasting the remaining step budget.
- If you see a login/sign-in gate on the first screen (e.g. "Sign in", "Create account", "Don't have an account?"), back out with the back action and pick a different top-level entry point that does not require authentication.
- Do NOT open external URLs, App Store sheets, or payment/subscription flows — they either leave the app or need real billing data.
- Prefer unvisited top-level navigation (tab bar, sidebar, primary menu items) over drilling deeper into a path you already explored.

== ACTION PREFERENCE ==
1. tapText with EXACT visible text — BEST option when element has readable text
2. tap with x/y (as percentages 0-100) — only when text is not visible
3. scroll / swipe — to reveal hidden content
4. wait — after navigation actions

Respond with ONLY a valid JSON object matching the schema. No markdown.`;
  }
}

// ── Standalone helpers (kept out of the class for testability) ────────

/** Phase label for the exploration budget — used to hint the agent. */
function phaseFor(step: number, total: number): string {
  const pct = step / total;
  if (pct <= 0.2) return 'orient';
  if (pct <= 0.8) return 'explore';
  return 'deep-dive';
}

/** Render the accessibility-tree block with a grade hint for the agent. */
function buildTreeBlock(parsed: ParsedTree | null): string {
  if (!parsed || parsed.grade === 'empty') {
    return `ACCESSIBILITY DATA: empty\nThe accessibility tree provides no usable labels for this screen. Rely entirely on visual analysis of the screenshot.`;
  }
  const header =
    parsed.grade === 'rich'
      ? `ACCESSIBILITY DATA: rich (${parsed.labeledElementCount} elements)\nUse this data for navigation planning and analysis grounding.`
      : `ACCESSIBILITY DATA: sparse (${parsed.labeledElementCount} elements)\nLimited tree data — rely primarily on visual analysis.`;
  return `${header}\n\nUI ELEMENTS ON SCREEN:\n${parsed.text}`;
}

// optimizeScreenshot was here — now uses shared optimizeScreenshot from core/image-utils.ts

/** Safe JSON.parse for the fallback path — returns null on error. */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Detect AbortError shapes across Node and various SDK wrappers. */
function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string; code?: string; cause?: unknown };
  if (e.name === 'AbortError') return true;
  if (e.code === 'ABORT_ERR' || e.code === 'ERR_ABORTED') return true;
  if (typeof e.message === 'string' && /abort/i.test(e.message)) return true;
  if (e.cause) return isAbortError(e.cause);
  return false;
}

/** Re-export so the executor can also extract nav targets from a parsed tree. */
export { extractNavTargets };
