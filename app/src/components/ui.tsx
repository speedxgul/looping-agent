import type { ReactNode } from 'react';

export function Panel({
  title,
  subtitle,
  count,
  children
}: {
  title: string;
  subtitle?: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-panel/60 backdrop-blur-sm">
      <header className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h2 className="font-sans text-sm font-semibold uppercase tracking-wider text-text">
            {title}
          </h2>
          {count !== undefined && (
            <span className="rounded-full bg-panel-2 px-2 py-0.5 font-sans text-xs text-muted">
              {count}
            </span>
          )}
        </div>
        {subtitle && <span className="font-sans text-xs text-muted">{subtitle}</span>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

type Tone = 'ok' | 'warn' | 'error' | 'muted' | 'info' | 'critical';

const TONE_CLASS: Record<Tone, string> = {
  ok: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  warn: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  error: 'bg-red-500/10 text-red-400 border-red-500/30',
  critical: 'bg-red-500/15 text-red-300 border-red-500/40',
  info: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  muted: 'bg-panel-2 text-muted border-border'
};

export function Badge({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

const DOT_CLASS: Record<Tone, string> = {
  ok: 'bg-emerald-400',
  warn: 'bg-amber-400',
  error: 'bg-red-400',
  critical: 'bg-red-400 animate-pulse',
  info: 'bg-blue-400',
  muted: 'bg-slate-500'
};

export function StatusDot({ tone = 'muted' }: { tone?: Tone }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${DOT_CLASS[tone]}`} />;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="py-2 text-sm text-muted">{children}</p>;
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: Tone }) {
  const valueClass =
    tone === 'ok'
      ? 'text-emerald-400'
      : tone === 'error' || tone === 'critical'
        ? 'text-red-400'
        : tone === 'warn'
          ? 'text-amber-400'
          : 'text-text';
  return (
    <div className="rounded-md border border-border bg-panel-2 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold ${valueClass}`}>{value}</div>
    </div>
  );
}

export function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted">
            {head}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return <th className={`px-2 py-2 font-medium ${right ? 'text-right' : ''}`}>{children}</th>;
}

export function Td({ children, right, mono }: { children: ReactNode; right?: boolean; mono?: boolean }) {
  return (
    <td className={`px-2 py-2 ${right ? 'text-right' : ''} ${mono ? 'tabular-nums' : ''}`}>
      {children}
    </td>
  );
}

export function ProtocolTag({ protocol }: { protocol: string }) {
  return <span className="capitalize text-text">{protocol}</span>;
}
