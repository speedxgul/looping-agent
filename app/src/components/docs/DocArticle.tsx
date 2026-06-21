import { notFound } from 'next/navigation';
import MarkdownView from '@/components/docs/MarkdownView';
import { readDoc } from '@/lib/docs';

export default async function DocArticle({ slug }: { slug: string }) {
  const doc = await readDoc(slug);
  if (!doc) notFound();

  return (
    <div>
      <div className="mb-6 border-b border-border pb-4">
        <p className="font-sans text-xs uppercase tracking-wider text-accent">{doc.entry.group}</p>
        <h1 className="mt-1 font-sans text-3xl font-semibold tracking-tight text-text">
          {doc.entry.title}
        </h1>
      </div>
      <MarkdownView content={doc.content} />
    </div>
  );
}
