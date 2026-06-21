'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { groupedDocs } from '@/lib/docsRegistry';

export default function DocsSidebar() {
  const pathname = usePathname();
  const groups = groupedDocs();

  return (
    <nav className="flex flex-col gap-6 font-sans text-sm">
      {groups.map((group) => (
        <div key={group.group}>
          <div className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted">
            {group.group}
          </div>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const href = item.slug === 'overview' ? '/docs' : `/docs/${item.slug}`;
              const active =
                pathname === href || (item.slug !== 'overview' && pathname === `/docs/${item.slug}`);
              return (
                <li key={item.slug}>
                  <Link
                    href={href}
                    className={`block rounded-lg px-3 py-1.5 transition-colors ${
                      active
                        ? 'bg-accent/10 text-accent'
                        : 'text-muted hover:bg-panel-2 hover:text-text'
                    }`}
                  >
                    {item.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
