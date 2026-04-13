import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAccessibilityTreeDetailed,
  extractLabels,
  extractNavTargets,
  parseAccessibilityTree,
} from '../src/core/tree-parser.ts';

/** Build a WDA-style XML tree with N labeled buttons, for boundary tests. */
function buildXmlWithNLabels(n: number): string {
  // Use a very tall virtual screen so all buttons stay on-screen and
  // aren't culled by the parser's viewport check.
  const screenH = 10000;
  const buttons = Array.from(
    { length: n },
    (_, i) =>
      `  <XCUIElementTypeButton label="Button${i}" x="10" y="${10 + i * 50}" width="100" height="40" visible="true"/>`,
  ).join('\n');
  return `<XCUIElementTypeApplication width="390" height="${screenH}">
${buttons}
</XCUIElementTypeApplication>`;
}

// ── Quality grading boundaries ───────────────────────────────────

test('grade: 0 labeled elements → empty', () => {
  const { grade, labeledElementCount } = parseAccessibilityTreeDetailed(buildXmlWithNLabels(0));
  assert.equal(labeledElementCount, 0);
  assert.equal(grade, 'empty');
});

test('grade: 1 labeled element → empty (threshold is ≥2)', () => {
  const { grade, labeledElementCount } = parseAccessibilityTreeDetailed(buildXmlWithNLabels(1));
  assert.equal(labeledElementCount, 1);
  assert.equal(grade, 'empty');
});

test('grade: 2 labeled elements → sparse', () => {
  const { grade, labeledElementCount } = parseAccessibilityTreeDetailed(buildXmlWithNLabels(2));
  assert.equal(labeledElementCount, 2);
  assert.equal(grade, 'sparse');
});

test('grade: 9 labeled elements → sparse', () => {
  const { grade, labeledElementCount } = parseAccessibilityTreeDetailed(buildXmlWithNLabels(9));
  assert.equal(labeledElementCount, 9);
  assert.equal(grade, 'sparse');
});

test('grade: 10 labeled elements → rich', () => {
  const { grade, labeledElementCount } = parseAccessibilityTreeDetailed(buildXmlWithNLabels(10));
  assert.equal(labeledElementCount, 10);
  assert.equal(grade, 'rich');
});

test('grade: 20 labeled elements → rich', () => {
  const { grade, labeledElementCount } = parseAccessibilityTreeDetailed(buildXmlWithNLabels(20));
  assert.equal(labeledElementCount, 20);
  assert.equal(grade, 'rich');
});

// ── extractLabels ────────────────────────────────────────────────

test('extractLabels: returns sorted labels', () => {
  const text = '[Button] "Zebra"\n[Cell] "Apple"\n[Link] "Mango"';
  assert.deepEqual(extractLabels(text), ['Apple', 'Mango', 'Zebra']);
});

test('extractLabels: handles empty input', () => {
  assert.deepEqual(extractLabels(''), []);
});

test('extractLabels: skips malformed lines', () => {
  const text = '[Button] "Real"\n<not a parsed line>\n[Cell] "Another"';
  assert.deepEqual(extractLabels(text), ['Another', 'Real']);
});

// ── extractNavTargets ────────────────────────────────────────────

test('extractNavTargets: pulls nav-like element types', () => {
  const text = [
    '[TabBar] "Home"',
    '[Button] "Settings"',
    '[Cell] "Profile"',
    '[Text] "Some body text"',
  ].join('\n');
  const targets = extractNavTargets(text);
  assert.ok(targets.includes('Home'));
  assert.ok(targets.includes('Settings'));
  assert.ok(targets.includes('Profile'));
  assert.ok(!targets.includes('Some body text'));
});

test('extractNavTargets: deduplicates identical labels', () => {
  const text = '[Button] "Home"\n[Cell] "Home"\n[Button] "Home"';
  assert.deepEqual(extractNavTargets(text), ['Home']);
});

test('extractNavTargets: drops long strings that look like content, not nav', () => {
  const longLabel = 'This is a very long body paragraph that should not be treated as nav target';
  const text = `[Button] "Home"\n[Cell] "${longLabel}"`;
  const targets = extractNavTargets(text);
  assert.ok(targets.includes('Home'));
  assert.ok(!targets.includes(longLabel));
});

test('extractNavTargets: empty tree returns empty array', () => {
  assert.deepEqual(extractNavTargets(''), []);
});

// ── Backward compatibility ──────────────────────────────────────

test('parseAccessibilityTree still returns plain string for existing callers', () => {
  const result = parseAccessibilityTree(buildXmlWithNLabels(3));
  assert.equal(typeof result, 'string');
  assert.ok(result.length > 0);
});

// ── WDA screen-dimension extraction (regression test for OPS review) ──

test('WDA parser: handles width before height in Application element', () => {
  const xml = '<XCUIElementTypeApplication width="390" height="844"><XCUIElementTypeButton label="Test" x="100" y="200" width="50" height="40" visible="true"/></XCUIElementTypeApplication>';
  const result = parseAccessibilityTree(xml);
  assert.ok(result.includes('"Test"'));
});

test('WDA parser: handles height before width in Application element', () => {
  const xml = '<XCUIElementTypeApplication height="844" width="390"><XCUIElementTypeButton label="Test" x="100" y="200" width="50" height="40" visible="true"/></XCUIElementTypeApplication>';
  const result = parseAccessibilityTree(xml);
  assert.ok(result.includes('"Test"'));
});
