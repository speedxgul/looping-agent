// Copies the repo-root markdown the docs viewer serves into app/content/, so the Next
// build has them INSIDE the project (Vercel deploys only the app/ root, so the parent
// repo's docs/*.md and README.md aren't otherwise available). Best-effort: never fails
// the build — docs.ts falls back to the repo root if this is skipped (e.g. local dev).
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const dest = path.resolve(here, '..', 'content');

// Mirror the registry's file paths under app/content/ (docsRegistry.ts `file` fields).
const entries = ['README.md', 'docs', 'agent/README.md', 'move/README.md', 'enclave/README.md'];

try {
  await rm(dest, { recursive: true, force: true });
  for (const rel of entries) {
    await mkdir(path.dirname(path.join(dest, rel)), { recursive: true });
    await cp(path.join(repoRoot, rel), path.join(dest, rel), { recursive: true });
  }
  console.log(`[sync-docs] copied ${entries.length} entries -> app/content/`);
} catch (err) {
  console.warn(`[sync-docs] skipped (${err.message}); docs.ts will fall back to the repo root`);
}
