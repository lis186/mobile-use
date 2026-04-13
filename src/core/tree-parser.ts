/**
 * Accessibility tree parsers — convert raw WDA XML / Maestro JSON / XCTest JSON
 * into concise text for LLM consumption.
 */

import type { TreeQuality } from '../types.js';

const MAX_CHARS = 2000;

/** Element count thresholds for quality grading (Decision 5). */
const GRADE_RICH_MIN = 10;
const GRADE_SPARSE_MIN = 2;

export function parseAccessibilityTree(raw: string): string {
  if (raw.trimStart().startsWith('<') || raw.trimStart().startsWith('<?xml')) {
    return parseWDATree(raw);
  }
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    // XCTest driver returns { axElement: { elementType: number, ... } }
    if (json.axElement) {
      return parseXCTestTree(json.axElement as XCTestElement);
    }
    return parseMaestroTree(json);
  } catch {
    return '';
  }
}

export function parseWDATree(xml: string): string {
  const lines: string[] = [];

  const getAttr = (attrs: string, name: string): string | null => {
    const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
    return m ? m[1]! : null;
  };

  // Extract screen dimensions from root Application element.
  // Use an order-independent lookup so XML attribute ordering can't break us.
  let screenW = 393, screenH = 852;
  const appMatch = xml.match(/<XCUIElementTypeApplication\s+([^>]*)>/);
  if (appMatch) {
    const appAttrs = appMatch[1]!;
    const w = getAttr(appAttrs, 'width');
    const h = getAttr(appAttrs, 'height');
    if (w) screenW = parseInt(w, 10);
    if (h) screenH = parseInt(h, 10);
  }

  const elementRegex = /<(XCUIElementType\w+)\s+([^>]*?)\/?\s*>/g;
  let match;

  while ((match = elementRegex.exec(xml)) !== null) {
    const typeName = match[1]!;
    const attrs = match[2]!;

    const label = getAttr(attrs, 'label') || getAttr(attrs, 'name') || getAttr(attrs, 'value');
    const visible = getAttr(attrs, 'visible');
    if (!label || visible === 'false') continue;

    const shortType = typeName.replace('XCUIElementType', '');
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

      if (px + pw < 0 || py + ph < 0 || px > screenW || py > screenH) continue;

      const pctX = Math.round((px / screenW) * 100);
      const pctY = Math.round((py / screenH) * 100);
      const pctX2 = Math.round(((px + pw) / screenW) * 100);
      const pctY2 = Math.round(((py + ph) / screenH) * 100);

      lines.push(`[${shortType}] "${label}" (${pctX},${pctY} - ${pctX2},${pctY2}) ${pw}×${ph}pt`);
    } else {
      lines.push(`[${shortType}] "${label}"`);
    }
  }

  let result = '';
  for (const line of lines) {
    if (result.length + line.length + 1 > MAX_CHARS) break;
    result += line + '\n';
  }
  return result.trimEnd();
}

export function parseMaestroTree(json: Record<string, unknown>): string {
  const lines: string[] = [];
  walkMaestroNode(json, lines);

  let result = '';
  for (const line of lines) {
    if (result.length + line.length + 1 > MAX_CHARS) break;
    result += line + '\n';
  }
  return result.trimEnd();
}

function walkMaestroNode(node: Record<string, unknown>, lines: string[]): void {
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
      walkMaestroNode(child, lines);
    }
  }
}

// ── XCTest Tree Parser ─────────────────────────────────────────

/** XCTest elementType numeric enum → human-readable name */
const XCTEST_ELEMENT_TYPES: Record<number, string> = {
  9: 'Button', 24: 'Toolbar', 36: 'Cell', 38: 'Table',
  40: 'Toggle', 42: 'Link', 46: 'Image', 47: 'Icon',
  48: 'Text', 49: 'TextField', 50: 'SecureTextField',
  51: 'DatePicker', 52: 'TextView', 53: 'Menu', 54: 'MenuItem',
  55: 'Picker', 56: 'PickerWheel', 57: 'NavBar',
  58: 'TabBar', 72: 'Slider', 73: 'Stepper', 74: 'Switch',
};

/** Skip container-only types that don't carry useful info */
const XCTEST_SKIP_TYPES = new Set([0, 1, 2, 3, 4, 5]);

interface XCTestElement {
  elementType?: number;
  label?: string;
  title?: string;
  value?: string;
  enabled?: boolean;
  frame?: { X: number; Y: number; Width: number; Height: number };
  children?: XCTestElement[];
}

export function parseXCTestTree(root: XCTestElement): string {
  // Find screen dimensions from the Application element (type 2)
  let screenW = 402, screenH = 874;
  if (root.elementType === 2 && root.frame) {
    screenW = root.frame.Width || screenW;
    screenH = root.frame.Height || screenH;
  } else if (root.children) {
    for (const child of root.children) {
      if (child.elementType === 2 && child.frame) {
        screenW = child.frame.Width || screenW;
        screenH = child.frame.Height || screenH;
        break;
      }
    }
  }

  const lines: string[] = [];
  walkXCTestNode(root, lines, screenW, screenH);

  let result = '';
  for (const line of lines) {
    if (result.length + line.length + 1 > MAX_CHARS) break;
    result += line + '\n';
  }
  return result.trimEnd();
}

function walkXCTestNode(
  node: XCTestElement, lines: string[],
  screenW: number, screenH: number,
): void {
  const et = node.elementType ?? -1;
  const label = node.label || node.title || (typeof node.value === 'string' ? node.value : '') || '';

  if (label && !XCTEST_SKIP_TYPES.has(et)) {
    const typeName = XCTEST_ELEMENT_TYPES[et] || `Type${et}`;
    const f = node.frame;

    if (f && f.Width > 0 && f.Height > 0) {
      // Skip off-screen elements
      if (f.X + f.Width < 0 || f.Y + f.Height < 0 || f.X > screenW || f.Y > screenH) {
        // still recurse children
      } else {
        const pctX = Math.round((f.X / screenW) * 100);
        const pctY = Math.round((f.Y / screenH) * 100);
        const pctX2 = Math.round(((f.X + f.Width) / screenW) * 100);
        const pctY2 = Math.round(((f.Y + f.Height) / screenH) * 100);
        lines.push(`[${typeName}] "${label}" (${pctX},${pctY} - ${pctX2},${pctY2}) ${Math.round(f.Width)}×${Math.round(f.Height)}pt`);
      }
    } else {
      lines.push(`[${typeName}] "${label}"`);
    }
  }

  if (node.children) {
    for (const child of node.children) {
      walkXCTestNode(child, lines, screenW, screenH);
    }
  }
}

// ── Audit-mode helpers ───────────────────────────────────────────

/** Rich detail from a parsed tree: text + grade + count for audit-mode use. */
export interface ParsedTree {
  text: string;
  grade: TreeQuality;
  labeledElementCount: number;
}

/** Parse a raw tree and also return its quality grade and element count. */
export function parseAccessibilityTreeDetailed(raw: string): ParsedTree {
  const text = parseAccessibilityTree(raw);
  const labeledElementCount = text ? text.split('\n').filter(Boolean).length : 0;
  let grade: TreeQuality;
  if (labeledElementCount >= GRADE_RICH_MIN) grade = 'rich';
  else if (labeledElementCount >= GRADE_SPARSE_MIN) grade = 'sparse';
  else grade = 'empty';
  return { text, grade, labeledElementCount };
}

/**
 * Pull the raw label from a single parsed line.
 * Example input: `[Button] "Settings" (10,20 - 30,40)`
 * Returns: `Settings` (or `null` if the line can't be parsed)
 */
function extractLabelFromLine(line: string): string | null {
  const m = line.match(/^\[[^\]]+\]\s+"([^"]+)"/);
  return m ? m[1]! : null;
}

/**
 * Extract the sorted list of labels from a parsed tree text.
 * Used as the input to MD5 fingerprinting for rich-grade screens.
 */
export function extractLabels(parsedText: string): string[] {
  if (!parsedText) return [];
  const labels: string[] = [];
  for (const line of parsedText.split('\n')) {
    const label = extractLabelFromLine(line);
    if (label) labels.push(label);
  }
  return labels.sort();
}

/**
 * Extract navigation target labels from a parsed tree.
 * Prioritizes tab bar / nav bar / menu items and common section headings.
 * Returns an empty array when the tree lacks recognisable navigation markers.
 */
export function extractNavTargets(parsedText: string): string[] {
  if (!parsedText) return [];
  const targets: string[] = [];
  const seen = new Set<string>();
  // Types most likely to represent navigation affordances.
  const navTypes = new Set(['Button', 'Cell', 'Link', 'TabBar', 'NavBar', 'MenuItem', 'Tab']);

  for (const line of parsedText.split('\n')) {
    const typeMatch = line.match(/^\[([^\]]+)\]/);
    if (!typeMatch) continue;
    const type = typeMatch[1]!;
    if (!navTypes.has(type)) continue;
    const label = extractLabelFromLine(line);
    if (!label) continue;
    if (label.length > 40) continue; // long strings are usually content, not nav
    if (seen.has(label)) continue;
    seen.add(label);
    targets.push(label);
  }

  return targets;
}
