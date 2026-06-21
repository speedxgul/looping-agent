'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { slugForFile } from '@/lib/docsRegistry';
import Mermaid from './Mermaid';

function resolveHref(href: string): { internal: boolean; href: string } {
  // In-repo markdown links -> internal /docs route when we know the slug.
  if (/\.md(#.*)?$/i.test(href) && !/^https?:\/\//i.test(href)) {
    const [file, hash] = href.split('#');
    const slug = slugForFile(file);
    if (slug) return { internal: true, href: `/docs/${slug}${hash ? `#${hash}` : ''}` };
  }
  return { internal: false, href };
}

function codeChild(children: ReactNode): { className?: string; children?: ReactNode } | null {
  const child = Array.isArray(children) ? children[0] : children;
  if (child && typeof child === 'object' && 'props' in child) {
    return (child as { props: { className?: string; children?: ReactNode } }).props;
  }
  return null;
}

const components: Components = {
  a({ href, children, ...props }) {
    const target = href ?? '';
    if (target.startsWith('#')) {
      return (
        <a href={target} {...props}>
          {children}
        </a>
      );
    }
    const { internal, href: resolved } = resolveHref(target);
    if (internal) {
      return <Link href={resolved}>{children}</Link>;
    }
    return (
      <a href={resolved} target="_blank" rel="noreferrer" {...props}>
        {children}
      </a>
    );
  },
  pre({ children }) {
    const props = codeChild(children);
    const match = /language-(\w+)/.exec(props?.className ?? '');
    if (match?.[1] === 'mermaid') {
      const code = String(props?.children ?? '').replace(/\n$/, '');
      return <Mermaid code={code} />;
    }
    return <pre>{children}</pre>;
  }
};

export default function MarkdownView({ content }: { content: string }) {
  return (
    <article className="prose prose-invert prose-docs max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </article>
  );
}
