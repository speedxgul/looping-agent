'use client';

import { useEffect, useId, useRef, useState } from 'react';

let initialized = false;

export default function Mermaid({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const rawId = useId();
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const id = `mmd-${rawId.replace(/[^a-zA-Z0-9]/g, '')}`;

    async function render() {
      try {
        const mermaid = (await import('mermaid')).default;
        if (!initialized) {
          mermaid.initialize({
            startOnLoad: false,
            theme: 'dark',
            securityLevel: 'strict',
            themeVariables: {
              fontFamily: 'var(--font-sans), ui-sans-serif, system-ui, sans-serif'
            }
          });
          initialized = true;
        }
        // Validate first so render() is never called on input it can't parse;
        // that is what leaks the "Syntax error" graphic into document.body.
        const ok = await mermaid.parse(code, { suppressErrors: true });
        if (!ok) {
          if (!cancelled) setError(true);
          return;
        }
        const { svg } = await mermaid.render(id, code);
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        // Remove any orphaned temp node mermaid may have appended to <body>.
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
      }
    }

    render();
    return () => {
      cancelled = true;
    };
  }, [code, rawId]);

  if (error) {
    return (
      <pre className="overflow-x-auto rounded-xl border border-border bg-panel-2 p-4 text-xs text-muted">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div
      ref={ref}
      className="my-6 flex justify-center overflow-x-auto rounded-xl border border-border bg-panel-2/60 p-4 [&_svg]:max-w-full"
    />
  );
}
