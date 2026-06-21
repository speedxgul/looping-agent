import DocArticle from '@/components/docs/DocArticle';
import { DOCS } from '@/lib/docsRegistry';

// Static: prerender every known doc at build (markdown is read then, baked into the page).
// dynamicParams=false → an unknown slug is a static 404, never a runtime fs read (fails on Vercel).
export const dynamicParams = false;

export function generateStaticParams() {
  return DOCS.filter((d) => d.slug !== 'overview').map((d) => ({ slug: d.slug }));
}

export default async function DocSlugPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <DocArticle slug={slug} />;
}
