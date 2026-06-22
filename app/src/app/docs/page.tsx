import DocArticle from '@/components/docs/DocArticle';

// Static: the markdown is read at build time (when the repo is checked out) and baked into
// the page, with no runtime fs read (which would fail on Vercel, where only app/ ships).

export default function DocsIndexPage() {
  return <DocArticle slug="overview" />;
}
