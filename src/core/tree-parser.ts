/**
 * Accessibility tree parsers — convert raw WDA XML / Maestro JSON
 * into concise text for LLM consumption.
 */

const MAX_CHARS = 2000;

export function parseAccessibilityTree(raw: string): string {
  if (raw.trimStart().startsWith('<') || raw.trimStart().startsWith('<?xml')) {
    return parseWDATree(raw);
  }
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    return parseMaestroTree(json);
  } catch {
    return '';
  }
}

export function parseWDATree(xml: string): string {
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

      lines.push(`[${shortType}] "${label}" (${pctX},${pctY} - ${pctX2},${pctY2})`);
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
