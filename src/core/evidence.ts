/**
 * Evidence capture with content-hash dedup.
 *
 * Every issue gets a filename like `ISSUE-003.jpg` that points at a shared
 * content-hashed source file `_<hash>.jpg`. Two issues produced by the same
 * step share storage via symlink (with copy fallback on filesystems that
 * reject symlinks).
 *
 * Raw screenshots are JPEG-optimized on ingest (quality 85) so the final
 * report stays around 5 MB even with ~40 evidence files.
 */

import { createHash } from 'node:crypto';
import { mkdir, stat, symlink, copyFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import sharp from 'sharp';

const SCREENSHOTS_SUBDIR = 'screenshots';

/**
 * Save a screenshot as evidence for a specific issue.
 * Returns the relative path (from outputDir) that the report will embed.
 */
export async function saveEvidence(
  outputDir: string,
  screenshotBuffer: Buffer,
  issueId: string,
): Promise<string> {
  const dir = path.join(outputDir, SCREENSHOTS_SUBDIR);
  await mkdir(dir, { recursive: true });

  // Content hash of the OPTIMIZED JPEG (so equivalent pixels → identical key)
  const optimized = await sharp(screenshotBuffer).jpeg({ quality: 85 }).toBuffer();
  const hash = createHash('sha1').update(optimized).digest('hex').slice(0, 12);

  const sourceName = `_${hash}.jpg`;
  const sourcePath = path.join(dir, sourceName);
  const linkPath = path.join(dir, `${issueId}.jpg`);

  // Write source file only if it doesn't exist yet
  if (!(await exists(sourcePath))) {
    await writeFile(sourcePath, optimized);
  }

  // Always create the per-issue pointer (may already exist from a retry)
  if (!(await exists(linkPath))) {
    try {
      await symlink(sourceName, linkPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' && (await exists(linkPath))) {
        // Race: another caller created it first — that's fine.
      } else if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') {
        // Filesystem rejects symlinks (FAT32, some NFS) — fall back to a copy.
        await copyFile(sourcePath, linkPath);
      } else {
        throw err;
      }
    }
  }

  return `${SCREENSHOTS_SUBDIR}/${issueId}.jpg`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
