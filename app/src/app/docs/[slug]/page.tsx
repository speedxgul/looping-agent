import DocArticle from '@/components/docs/DocArticle';
import { DOCS } from '@/lib/docsRegistry';

export const dynamic = 'force-dynamic';

export function generateStaticParams() {
  return DOCS.filter((d) => d.slug !== 'overview').map((d) => ({ slug: d.slug }));
}

export default async function DocSlugPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <DocArticle slug={slug} />;
}
