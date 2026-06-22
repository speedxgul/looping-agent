'use client';

import { useEffect, useRef, useState } from 'react';

let initialized = false;
let renderSeq = 0;

export default function Mermaid({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Unique per effect invocation so React StrictMode's double-mount (dev)
    // never reuses an id between two in-flight renders, which would collide
    // and throw, dropping a valid diagram to the error fallback.
    const id = `mermaid-${(renderSeq += 1)}`;

    async function render() {
      try {
        const mermaid = (await import('mermaid')).default;
        if (!initialized) {
          mermaid.initialize({
            startOnLoad: false,
            theme: 'dark',
            securityLevel: 'loose',
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
        // mermaid may leave a measurement node in <body>. Remove ONLY a node that is a
        // direct child of <body>, never the injected <svg>, which carries this same id but
        // lives inside our ref. (Removing it by id was blanking every rendered diagram.)
        for (const orphan of [document.getElementById(id), document.getElementById(`d${id}`)]) {
          if (orphan && orphan.parentElement === document.body) orphan.remove();
        }
      }
    }

    render();
    return () => {
      cancelled = true;
    };
  }, [code]);

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
