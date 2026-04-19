/**
 * Zod schema for the audit agent's structured output.
 *
 * Used with AI SDK's generateObject() to force the model into a stable
 * shape. POC (OPS-2) confirmed compliance with Gemini 2.5 Flash + vision.
 *
 * Every description is deliberate: Gemini uses them as part of the
 * constrained-decoding hint, so the wording drives output quality.
 */

import { z } from 'zod';

export const auditIssueSchema = z.object({
  title: z
    .string()
    .min(5)
    .describe('concise human-readable issue title, 5-60 characters'),
  severity: z
    .enum(['high', 'medium', 'low'])
    .describe('high = blocks task, medium = causes friction, low = minor'),
  principle: z
    .string()
    .describe('violated principle, e.g. "Norman:Affordance" or "Nielsen:Consistency" or "iOS HIG:Tap Target"'),
  persona: z
    .enum(['rushed', 'firsttime', 'power'])
    .optional()
    .describe('persona most impacted by this issue; omit if all users are affected equally'),
  evidence: z
    .string()
    .min(20)
    .describe('concrete visual evidence you observed, ≥ 20 chars; must cite specific pixels/colors/sizes/positions, not vague impressions'),
  confidence: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe('integer 0-100 percent; your confidence this is a real issue worth fixing'),
  cognitiveImpact: z
    .string()
    .min(20)
    .describe('explain HOW the user\'s cognition fails: what mental model breaks, what gulf of execution/evaluation exists, what the user experiences as friction — not just a principle label'),
  recommendation: z
    .string()
    .min(10)
    .describe('specific actionable fix a developer can implement'),
  measured_width_pt: z
    .number()
    .optional()
    .describe('actual width in points from accessibility tree frame data; include when citing a tap target size issue'),
  measured_height_pt: z
    .number()
    .optional()
    .describe('actual height in points from accessibility tree frame data; include when citing a tap target size issue'),
  elementX: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe('x position of the flagged element centre as a percentage of screen width (0–100); REQUIRED for contrast issues so pixel-accurate WCAG measurement can be computed automatically'),
  elementY: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe('y position of the flagged element centre as a percentage of screen height (0–100); REQUIRED for contrast issues so pixel-accurate WCAG measurement can be computed automatically'),
});

export const auditBlockSchema = z.object({
  issues: z
    .array(auditIssueSchema)
    .describe('only real UX issues with concrete evidence; empty array if none'),
});

export const navigationSchema = z.object({
  action: z
    .enum([
      'tap',
      'tapText',
      'doubleTap',
      'longPress',
      'inputText',
      'eraseText',
      'scroll',
      'swipe',
      'back',
      'hideKeyboard',
      'openLink',
      'pressKey',
      'wait',
      'launchApp',
      'stopApp',
      'done',
      'failed',
    ])
    .describe('next action to advance exploration'),
  target: z
    .string()
    .describe('plain-language name of the UI element you are interacting with'),
  text: z
    .string()
    .optional()
    .describe('exact visible text to tap; PREFERRED over x/y coordinates'),
  x: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe('tap position as percentage 0-100 of screen width; ONLY use when visible text is unavailable'),
  y: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe('tap position as percentage 0-100 of screen height; ONLY use when visible text is unavailable'),
  startX: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe('gesture start x as percentage 0-100 of screen width; for scroll/swipe'),
  startY: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe('gesture start y as percentage 0-100 of screen height; for scroll/swipe'),
  endX: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe('gesture end x as percentage 0-100 of screen width; for scroll/swipe'),
  endY: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe('gesture end y as percentage 0-100 of screen height; for scroll/swipe. Lower Y than startY means swiping upward (e.g. scroll down the content)'),
  appId: z.string().optional().describe('bundle ID for launchApp / stopApp'),
  url: z.string().optional().describe('URL for openLink'),
  key: z.string().optional().describe('key name for pressKey'),
});

export const auditDecisionSchema = z.object({
  navigation: navigationSchema,
  screenName: z
    .string()
    .min(1)
    .describe('ALWAYS required. Descriptive name for the current screen, e.g. "Chat list" or "Settings > Notifications". Provide on every step regardless of whether issues are present.'),
  audit: auditBlockSchema
    .optional()
    .describe('ONLY include when real UX issues are present on this screen; omit entirely otherwise'),
  reasoning: z
    .string()
    .min(5)
    .describe('one or two sentences explaining why you chose this navigation action'),
  onboardingDetected: z
    .boolean()
    .optional()
    .describe('set to true when the current screen is a tutorial / walkthrough / welcome / what-is-new dialog so it can be excluded from coverage'),
  progress: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe('integer 0-100 where 100 = audit goal fully reached'),
});

export type AuditDecision = z.infer<typeof auditDecisionSchema>;
export type NavigationAction = z.infer<typeof navigationSchema>;
export type AuditBlock = z.infer<typeof auditBlockSchema>;
export type AuditIssueFromSchema = z.infer<typeof auditIssueSchema>;
