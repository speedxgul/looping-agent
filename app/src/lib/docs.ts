import { promises as fs } from 'node:fs';
import path from 'node:path';
import { type DocEntry, getDocEntry } from './docsRegistry';

export * from './docsRegistry';

/**
 * Repo root that holds the markdown. Defaults to the parent of the app/ folder;
 * override with DOCS_DIR (absolute, or relative to the app/ working directory).
 */
function docsRoot(): string {
  const configured = process.env.DOCS_DIR?.trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }
  return path.resolve(process.cwd(), '..');
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
