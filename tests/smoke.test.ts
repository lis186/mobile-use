import { test } from 'node:test';
import assert from 'node:assert/strict';

test('test runner is alive', () => {
  assert.equal(1 + 1, 2);
});

test('tsx can resolve a TS import from src/', async () => {
  const { AuditError } = await import('../src/errors/audit-errors.ts');
  const err = new AuditError('E_USER_ABORTED', 'test hint');
  assert.equal(err.code, 'E_USER_ABORTED');
  assert.ok(err.message.includes('E_USER_ABORTED'));
});
