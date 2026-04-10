/**
 * Type definitions for phone-use
 */

export type RunnerType = 'maestro' | 'maestro-runner' | 'wda' | 'xctest';

export interface TaskConfig {
  bundleId?: string;
  task: string;
  maxSteps: number;
  model?: string;
  language?: string;
  successCriteria?: string[];
  constraints?: string[];
  deviceId?: string;
  iosDevice?: IosDeviceConfig;
  runner?: RunnerType;
}

export interface IosDeviceConfig {
  udid: string;
  teamId?: string;
  appFile?: string;
  driverPort?: number;
}

export interface AgentDecision {
  action:
    | 'tap'
    | 'tapText'
    | 'doubleTap'
    | 'longPress'
    | 'inputText'
    | 'eraseText'
    | 'scroll'
    | 'swipe'
    | 'back'
    | 'hideKeyboard'
    | 'openLink'
    | 'pressKey'
    | 'wait'
    | 'launchApp'
    | 'stopApp'
    | 'done'
    | 'failed';
  params?: AgentParams;
  reasoning: string;
  progress: number;
  needsUserInput?: boolean;
  userInputPrompt?: string;
}

export interface AgentParams {
  x?: number;
  y?: number;
  text?: string;
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  key?: string;
  url?: string;
  chars?: number;
  timeout?: number;
  appId?: string;
}

export interface ExecutionResult {
  success: boolean;
  reason: string;
  steps: number;
}

export interface AgentContext {
  stepNumber: number;
  maxSteps: number;
  actionHistory: string[];
  accessibilityTree?: string;
  language?: string;
  successCriteria?: string[];
  constraints?: string[];
}

// ── Audit mode types ─────────────────────────────────────────────

/** Accessibility tree quality grade — drives fingerprinting strategy and prompt hints */
export type TreeQuality = 'rich' | 'sparse' | 'empty';

/** Audit CLI configuration, built from parsed flags in src/index.ts */
export interface AuditConfig {
  bundleId: string;
  runner: RunnerType;
  deviceId?: string;
  iosDevice?: IosDeviceConfig;
  language?: string;
  scope?: string;
  model: string;
  maxSteps: number;
  outputDir: string;
  stableTimeout: number;
  maxRetries: number;
  rpmLimit: number;
  tokenBudget: number;
  hardTimeout: number;
  skipLaunch: boolean;
  live: boolean;
  livePort: number;
}

/** A single UX issue discovered during an audit step */
export interface AuditIssue {
  id: string;               // e.g. "ISSUE-001"
  title: string;
  severity: 'high' | 'medium' | 'low';
  screenName: string;
  principle: string;        // e.g. "Norman:Affordance" or "Nielsen:Consistency"
  persona?: string;         // e.g. "rushed" | "firsttime" | "power"
  evidence: string;         // concrete visual evidence, ≥20 chars
  confidence: number;       // 0-100 integer
  recommendation: string;
  stepNumber: number;
  evidencePath: string;     // relative path to annotated screenshot
}

/** Visited screen record used by the exploration map */
export interface VisitedScreen {
  fingerprint: string;      // 8-char hex
  name: string;             // human-readable name from AI
  count: number;            // how many times visited
  firstStep: number;
  issuesFound: number;
}

/** Per-step performance measurement */
export interface StepTiming {
  step: number;
  screenshot_ms: number;
  tree_ms: number;
  ai_ms: number;
  action_ms: number;
  sleep_ms: number;
  total_ms: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
}

/** Per-step record written to steps.jsonl for streaming persistence */
export interface StepRecord {
  step: number;
  fingerprint: string;
  screenName: string;
  action: string;
  reasoning: string;
  issuesFound: string[];    // array of issue IDs
  onboarding: boolean;
  timing: StepTiming;
}

/** The final audit report structure passed to the renderer */
export interface AuditReport {
  bundleId: string;
  runner: RunnerType;
  device: string;
  iosVersion?: string;
  model: string;
  startedAt: string;        // ISO timestamp
  durationMs: number;
  stepsTotal: number;
  stepsOnboarding: number;
  uniqueScreens: number;
  issues: AuditIssue[];
  visited: VisitedScreen[];
  timings: StepTiming[];
  estimatedCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  partial: boolean;         // true if run ended early
  partialReason?: string;   // AuditError code if partial
}
