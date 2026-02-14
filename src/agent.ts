import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, type ModelMessage, type LanguageModel } from 'ai';
import sharp from 'sharp';
import type { AgentDecision, AgentContext } from './types.js';

type AIProvider = 'google' | 'openai';

export class TaskAgent {
  private provider: AIProvider;
  private openai?: ReturnType<typeof createOpenAI>;
  private google?: ReturnType<typeof createGoogleGenerativeAI>;
  private conversationHistory: ModelMessage[] = [];
  private model: string;

  constructor(apiKey: string, model: string = 'gemini-2.5-flash', provider: AIProvider = 'google') {
    this.provider = provider;
    this.model = model;

    if (provider === 'google') {
      this.google = createGoogleGenerativeAI({ apiKey });
    } else {
      this.openai = createOpenAI({ apiKey });
    }
  }

  private getModel(): LanguageModel {
    if (this.provider === 'google' && this.google) {
      return this.google(this.model);
    }
    return this.openai!(this.model);
  }

  async decide(
    screenshot: string,
    task: string,
    context: AgentContext
  ): Promise<AgentDecision> {
    const systemPrompt = this.buildSystemPrompt(task, context);
    const rawBuffer = Buffer.from(screenshot, 'base64');
    const imageBuffer = await this.optimizeImage(rawBuffer);

    const stuckWarning = this.detectStuckPattern(context.actionHistory);

    const content: Array<{ type: 'image'; image: Buffer } | { type: 'text'; text: string }> = [
      { type: 'image', image: imageBuffer },
    ];

    // Add accessibility tree if available and passes quality gate
    if (context.accessibilityTree) {
      const parsedTree = this.parseAccessibilityTree(context.accessibilityTree);
      const elementCount = parsedTree ? parsedTree.split('\n').length : 0;
      if (elementCount >= 2) {
        content.push({
          type: 'text',
          text: `UI ELEMENTS ON SCREEN:\n${parsedTree}`,
        });
        console.log(`  🌳 Tree: ${elementCount} elements (included)`);
      } else {
        console.log(`  🌳 Tree: ${elementCount} element${elementCount !== 1 ? 's' : ''} (skipped — too sparse)`);
      }
    }

    content.push({
      type: 'text',
      text: stuckWarning
        ? `${stuckWarning}\n\nAnalyze the screenshot. What DIFFERENT action should you try?`
        : 'Analyze the screenshot. What is the ONE best action to progress toward the task goal?',
    });

    const userMessage: ModelMessage = {
      role: 'user',
      content,
    };

    this.conversationHistory.push(userMessage);
    this.trimHistory();

    const response = await generateText({
      model: this.getModel(),
      system: systemPrompt,
      messages: this.conversationHistory,
    });

    this.conversationHistory.push({
      role: 'assistant',
      content: response.text,
    });

    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in AI response');
    }

    return JSON.parse(jsonMatch[0]) as AgentDecision;
  }

  private async optimizeImage(buffer: Buffer): Promise<Buffer> {
    const metadata = await sharp(buffer).metadata();
    const origW = metadata.width ?? 0;
    const origH = metadata.height ?? 0;
    const origSize = buffer.length;

    // Resize to ~1/2 and convert to JPEG
    const targetWidth = Math.round(origW / 2);
    const optimized = await sharp(buffer)
      .resize(targetWidth)
      .jpeg({ quality: 80 })
      .toBuffer();

    const ratio = ((1 - optimized.length / origSize) * 100).toFixed(0);
    console.log(
      `  📐 Image: ${origW}x${origH} → ${targetWidth}x${Math.round(origH / 2)} ` +
      `(${(origSize / 1024).toFixed(0)}KB → ${(optimized.length / 1024).toFixed(0)}KB, -${ratio}%)`
    );

    return optimized;
  }

  /**
   * Keep images only in the last KEEP_IMAGES user messages.
   * Older user messages get images stripped to text-only summaries,
   * drastically reducing vision tokens while preserving action context.
   */
  private trimHistory(): void {
    const KEEP_IMAGES = 2; // keep screenshots in last 2 user msgs
    const MAX_MESSAGES = 20; // can keep more now that old msgs are text-only

    if (this.conversationHistory.length > MAX_MESSAGES) {
      this.conversationHistory = this.conversationHistory.slice(-MAX_MESSAGES);
    }

    // Count user messages from the end to find which ones to strip
    let userMsgCount = 0;
    for (let i = this.conversationHistory.length - 1; i >= 0; i--) {
      const msg = this.conversationHistory[i]!;
      if (msg.role === 'user') {
        userMsgCount++;
        if (userMsgCount > KEEP_IMAGES && Array.isArray(msg.content)) {
          const textParts = msg.content
            .filter((p: { type: string }) => p.type === 'text')
            .map((p: { type: string; text?: string }) => p.text ?? '');

          this.conversationHistory[i] = {
            role: 'user',
            content: `[screenshot omitted] ${textParts.join(' ')}`,
          };
        }
      }
    }
  }

  private detectStuckPattern(history: string[]): string | null {
    if (history.length < 3) return null;

    const lastThree = history.slice(-3);
    const allSame = lastThree.every((a) => a === lastThree[0]);

    if (allSame) {
      return `WARNING: You've tried "${lastThree[0]}" 3 times with no progress. The tap coordinates may be WRONG. Try:
1. DIFFERENT coordinates (shift by 5-10%)
2. tapText instead of tap (if there's visible text)
3. scroll to reveal hidden elements
4. A completely different approach`;
    }

    const tapPattern = lastThree.filter((a) => a.startsWith('tap('));
    if (tapPattern.length >= 2) {
      return `NOTE: Multiple tap attempts detected. If tapping isn't working, the button might be at different coordinates than expected. Try adjusting by 5-10% or use tapText if visible text exists.`;
    }

    return null;
  }

  private buildSystemPrompt(task: string, context: AgentContext): string {
    const criteriaSection = context.successCriteria
      ? `SUCCESS CRITERIA:\n${context.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
      : '';

    const constraintsSection = context.constraints
      ? `CONSTRAINTS:\n${context.constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
      : '';

    const languageSection = context.language
      ? `IMPORTANT: The device UI language is ${resolveLanguage(context.language)}.
All labels, buttons, and menu items are in this language.
When using tapText, always use the EXACT text visible on screen, not English translations.`
      : '';

    return `You are an AI agent controlling a mobile app to complete a task.

${languageSection}

OBJECTIVE: ${task}

${criteriaSection}
${constraintsSection}

COORDINATE ESTIMATION GUIDE
You see the screenshot. Estimate tap positions as PERCENTAGES (0-100):
- 0% = left/top edge, 50% = center, 100% = right/bottom edge

Common UI patterns:
- Floating Action Button (FAB, usually "+"): typically at {x: 85, y: 85} NOT {x: 90, y: 90}
- Navigation back arrow: {x: 5-10, y: 6-8}
- Top-right action button: {x: 90-95, y: 6-8}
- Tab bar items: y: 92-96, x varies by position
- Center of screen: {x: 50, y: 50}
- Text fields: estimate center of the field visually

CRITICAL: Don't use exact corners (0, 100). Buttons have padding.

ACTION PRIORITY
1. tapText - BEST when you see readable text on a button. Use EXACT visible text.
2. tap - For icons or when tapText might fail. Estimate coordinates carefully.
3. inputText - ONLY after tapping a text field (you should see cursor/keyboard)
4. scroll - To reveal content below the fold
5. wait - After navigation actions

AVAILABLE ACTIONS

tap: Tap at coordinates
  {"action": "tap", "params": {"x": 85, "y": 85}, "reasoning": "...", "progress": N}

tapText: Tap by visible text (preferred when text is visible)
  {"action": "tapText", "params": {"text": "Add Note"}, "reasoning": "...", "progress": N}

inputText: Type into focused field
  {"action": "inputText", "params": {"text": "Your text here"}, "reasoning": "...", "progress": N}
  For long text (>200 chars): use multiple inputText calls

scroll: Scroll down
  {"action": "scroll", "params": {}, "reasoning": "...", "progress": N}

swipe: Swipe gesture
  {"action": "swipe", "params": {"startX": 50, "startY": 80, "endX": 50, "endY": 20}, "reasoning": "...", "progress": N}

wait: Wait for animations
  {"action": "wait", "params": {}, "reasoning": "...", "progress": N}

hideKeyboard: Dismiss keyboard
  {"action": "hideKeyboard", "params": {}, "reasoning": "...", "progress": N}

launchApp: Switch to a different app (for multi-app tasks)
  {"action": "launchApp", "params": {"appId": "com.example.app"}, "reasoning": "...", "progress": N}

stopApp: Close/stop an app
  {"action": "stopApp", "params": {"appId": "com.example.app"}, "reasoning": "...", "progress": N}

done: Task complete (only when VERIFIED on screen)
  {"action": "done", "params": {}, "reasoning": "...", "progress": 100}

failed: Cannot complete (only after 10+ different attempts)
  {"action": "failed", "params": {}, "reasoning": "...", "progress": N}

ACCESSIBILITY TREE
You may receive a "UI ELEMENTS ON SCREEN" section listing visible elements with their types, labels, and approximate positions (as percentages).
- Use element labels for tapText actions (EXACT match)
- Use element positions as hints for tap coordinate estimation
- If tree data conflicts with what you see in the screenshot, trust the screenshot

WHEN STUCK (same action 2+ times with no change):
1. Your coordinates are probably WRONG - shift by 5-10%
2. Try tapText instead of tap coordinates
3. Try scroll to reveal hidden elements
4. Try a completely different element

PROGRESS: Step ${context.stepNumber}/${context.maxSteps}
Recent: ${context.actionHistory.slice(-5).join(' -> ') || 'none'}

Respond with ONLY valid JSON (no markdown):`;
  }

  reset(): void {
    this.conversationHistory = [];
  }

  // ── Accessibility Tree Parsing ──────────────────────────────

  private parseAccessibilityTree(raw: string): string {
    if (raw.trimStart().startsWith('<') || raw.trimStart().startsWith('<?xml')) {
      return this.parseWDATree(raw);
    }
    try {
      const json = JSON.parse(raw) as Record<string, unknown>;
      return this.parseMaestroTree(json);
    } catch {
      return '';
    }
  }

  private parseWDATree(xml: string): string {
    const lines: string[] = [];

    // Extract screen dimensions from root Application element
    let screenW = 393, screenH = 852;
    const appMatch = xml.match(/<XCUIElementTypeApplication\s+[^>]*?width="(\d+)"[^>]*?height="(\d+)"/);
    if (appMatch) {
      screenW = parseInt(appMatch[1]!, 10);
      screenH = parseInt(appMatch[2]!, 10);
    }

    const getAttr = (attrs: string, name: string): string | null => {
      const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
      return m ? m[1]! : null;
    };

    // Match all XCUIElementType elements
    const elementRegex = /<(XCUIElementType\w+)\s+([^>]*?)\/?\s*>/g;
    let match;

    while ((match = elementRegex.exec(xml)) !== null) {
      const typeName = match[1]!;
      const attrs = match[2]!;

      const label = getAttr(attrs, 'label') || getAttr(attrs, 'name') || getAttr(attrs, 'value');
      const visible = getAttr(attrs, 'visible');
      if (!label || visible === 'false') continue;

      const shortType = typeName.replace('XCUIElementType', '');
      // Skip generic containers
      if (['Other', 'Window', 'Application'].includes(shortType)) continue;

      const x = getAttr(attrs, 'x');
      const y = getAttr(attrs, 'y');
      const w = getAttr(attrs, 'width');
      const h = getAttr(attrs, 'height');

      if (x && y && w && h) {
        const px = parseInt(x, 10);
        const py = parseInt(y, 10);
        const pw = parseInt(w, 10);
        const ph = parseInt(h, 10);

        // Skip off-screen elements
        if (px + pw < 0 || py + ph < 0 || px > screenW || py > screenH) continue;

        const pctX = Math.round((px / screenW) * 100);
        const pctY = Math.round((py / screenH) * 100);
        const pctX2 = Math.round(((px + pw) / screenW) * 100);
        const pctY2 = Math.round(((py + ph) / screenH) * 100);

        lines.push(`[${shortType}] "${label}" (${pctX},${pctY} - ${pctX2},${pctY2})`);
      } else {
        lines.push(`[${shortType}] "${label}"`);
      }
    }

    // Cap at ~2000 chars
    let result = '';
    for (const line of lines) {
      if (result.length + line.length + 1 > 2000) break;
      result += line + '\n';
    }
    return result.trimEnd();
  }

  private parseMaestroTree(json: Record<string, unknown>): string {
    const lines: string[] = [];
    this.walkMaestroNode(json, lines);

    let result = '';
    for (const line of lines) {
      if (result.length + line.length + 1 > 2000) break;
      result += line + '\n';
    }
    return result.trimEnd();
  }

  private walkMaestroNode(node: Record<string, unknown>, lines: string[]): void {
    if (node.visible === false) return;

    const text = (node.text as string) || (node.label as string) || (node.name as string) || '';
    const type = (node.type as string) || (node.elementType as string) || '';

    if (text && type) {
      const shortType = type.replace(/^.*\./, '');
      lines.push(`[${shortType}] "${text}"`);
    }

    const children = node.children as Record<string, unknown>[] | undefined;
    if (children) {
      for (const child of children) {
        this.walkMaestroNode(child, lines);
      }
    }
  }
}

const LANGUAGE_MAP: Record<string, string> = {
  'zh-TW': 'Traditional Chinese (繁體中文)',
  'zh-CN': 'Simplified Chinese (简体中文)',
  'ja': 'Japanese (日本語)',
  'ko': 'Korean (한국어)',
  'en': 'English',
  'es': 'Spanish (Español)',
  'fr': 'French (Français)',
  'de': 'German (Deutsch)',
  'pt': 'Portuguese (Português)',
  'th': 'Thai (ภาษาไทย)',
  'vi': 'Vietnamese (Tiếng Việt)',
  'ar': 'Arabic (العربية)',
};

function resolveLanguage(input: string): string {
  return LANGUAGE_MAP[input] ?? input;
}
