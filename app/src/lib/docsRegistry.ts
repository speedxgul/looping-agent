// Pure docs registry (no node APIs) so it is safe to import from client
// components. Filesystem reads live in docs.ts (server-only).

export interface DocEntry {
  slug: string;
  title: string;
  group: string;
  /** Path relative to the repo root. */
  file: string;
}

/**
 * Whitelisted docs. Slugs map to fixed files relative to the repo root, so a
 * request can never read an arbitrary path. The first entry is the default.
 */
export const DOCS: DocEntry[] = [
  { slug: 'overview', title: 'Overview', group: 'Getting started', file: 'README.md' },
  { slug: 'architecture', title: 'Architecture', group: 'Core', file: 'docs/architecture.md' },
  { slug: 'strategies', title: 'Strategies & Math', group: 'Core', file: 'docs/strategies.md' },
  {
    slug: 'subagent-pipeline',
    title: 'Subagent Pipeline',
    group: 'Core',
    file: 'docs/subagent-pipeline.md'
  },
  { slug: 'autonomy', title: 'Autonomy', group: 'Core', file: 'docs/autonomy.md' },
  {
    slug: 'treasury-design',
    title: 'TEE Treasury Design',
    group: 'Design',
    file: 'docs/treasury-agent-design.md'
  },
  { slug: 'deployment', title: 'Deployment', group: 'Operations', file: 'docs/deployment.md' },
  {
    slug: 'deploy-runbook',
    title: 'Deploy Runbook (mainnet)',
    group: 'Operations',
    file: 'docs/deploy-runbook.md'
  },
  { slug: 'agent', title: 'Agent Package', group: 'Packages', file: 'agent/README.md' },
  { slug: 'move', title: 'Move Package', group: 'Packages', file: 'move/README.md' },
  { slug: 'enclave', title: 'Enclave', group: 'Packages', file: 'enclave/README.md' }
];

export function listDocs(): DocEntry[] {
  return DOCS;
}

export function getDocEntry(slug: string): DocEntry | undefined {
  return DOCS.find((d) => d.slug === slug);
}

/** Map a relative .md href (from inside a doc) to a /docs slug, if known. */
export function slugForFile(relativeFile: string): string | undefined {
  const normalized = relativeFile.replace(/^\.\//, '').replace(/^\//, '');
  const base = normalized.split('/').pop()?.toLowerCase();
  return DOCS.find(
    (d) => d.file === normalized || d.file.split('/').pop()?.toLowerCase() === base
  )?.slug;
}

export function groupedDocs(): { group: string; items: DocEntry[] }[] {
  const groups: { group: string; items: DocEntry[] }[] = [];
  for (const doc of DOCS) {
    let g = groups.find((x) => x.group === doc.group);
    if (!g) {
      g = { group: doc.group, items: [] };
      groups.push(g);
    }
    g.items.push(doc);
  }
  return groups;
}
