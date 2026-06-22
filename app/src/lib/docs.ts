import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { type DocEntry, getDocEntry } from './docsRegistry';

export * from './docsRegistry';

/**
 * Where the markdown lives. Override with DOCS_DIR (absolute, or relative to app/).
 * Otherwise prefer `app/content/`, the copy `scripts/sync-docs.mjs` syncs in at build,
 * so it ships INSIDE the deployed app/ (Vercel only deploys app/). Falls back to the
 * repo root for local monorepo dev, where the docs are read live.
 */
function docsRoot(): string {
  const configured = process.env.DOCS_DIR?.trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }
  const bundled = path.resolve(process.cwd(), 'content');
  return existsSync(bundled) ? bundled : path.resolve(process.cwd(), '..');
}

export async function readDoc(slug: string): Promise<{ entry: DocEntry; content: string } | null> {
  const entry = getDocEntry(slug);
  if (!entry) return null;
  try {
    const content = await fs.readFile(path.join(docsRoot(), entry.file), 'utf8');
    return { entry, content };
  } catch {
    return null;
  }
}
