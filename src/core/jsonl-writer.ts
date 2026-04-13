/**
 * Append-only JSONL streaming persistence.
 *
 * Every step and every issue is flushed to disk immediately so a crash or
 * SIGKILL mid-run leaves a recoverable record. finalizeReport() reads these
 * files back at the end to render the Markdown report.
 */

import { appendFile, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { AuditIssue, StepRecord } from '../types.js';

/**
 * Append a single step record to steps.jsonl in the output directory.
 * Callers must ensure the output directory exists before the first call
 * (AuditExecutor.initOutputDir handles this).
 */
export async function appendStep(outputDir: string, record: StepRecord): Promise<void> {
  const line = JSON.stringify(record) + '\n';
  await appendFile(path.join(outputDir, 'steps.jsonl'), line, 'utf-8');
}

/** Append a single issue record to issues.jsonl in the output directory. */
export async function appendIssue(outputDir: string, issue: AuditIssue): Promise<void> {
  const line = JSON.stringify(issue) + '\n';
  await appendFile(path.join(outputDir, 'issues.jsonl'), line, 'utf-8');
}

/**
 * Read back a JSONL file as an array of parsed objects.
 * Silently tolerates a missing file (returns []) and drops malformed lines.
 */
export async function readJsonl<T>(filePath: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const lines = raw.split('\n').filter(Boolean);
  const out: T[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip malformed lines — don't fail the whole read
    }
  }
  return out;
}
