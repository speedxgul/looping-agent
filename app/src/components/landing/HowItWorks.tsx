// The product as its flow: Decide -> Attest -> Verify -> Custody. A connected journey
// (not a grid of cards) so the whole pipeline reads as one story, each stage equal weight.

const STAGES = [
  {
    n: '01',
    title: 'Decide',
    body: 'An LLM agent and a deterministic six-subagent pipeline propose an allocation, both bounded by the same policy.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-6 w-6">
        <circle cx="6.5" cy="7.5" r="2" />
        <circle cx="6.5" cy="16.5" r="2" />
        <circle cx="17.5" cy="12" r="2" />
        <path d="M8.5 7.5h3a4 4 0 0 1 4 4M8.5 16.5h3a4 4 0 0 0 4-4" strokeLinecap="round" />
      </svg>
    )
  },
  {
    n: '02',
    title: 'Attest',
    body: 'The optimizer signs the decision inside a TEE (Nautilus · Marlin Oyster); its key is PCR-bound on-chain, so the agent can’t puppet the venue or amount.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-6 w-6">
        <path d="M12 3l7 3v5c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3z" strokeLinejoin="round" />
        <path d="M9.3 12l1.8 1.8 3.6-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  },
  {
    n: '03',
    title: 'Verify',
    body: 'The contract checks the enclave signature, adapter allow-list, nonce, and caps, on-chain, before a single coin is released.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-6 w-6">
        <circle cx="12" cy="12" r="9" />
        <path d="M8 12l2.5 2.5L16 9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  },
  {
    n: '04',
    title: 'Custody',
    body: 'Funds deploy across Suilend, NAVI & Scallop; the receipt stays in the non-custodial Treasury, with owner-only withdrawal, archived to Walrus.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-6 w-6">
        <rect x="4" y="9" width="16" height="11" rx="2" />
        <path d="M8 9V7a4 4 0 0 1 8 0v2" strokeLinecap="round" />
        <circle cx="12" cy="14.5" r="1.4" fill="currentColor" stroke="none" />
      </svg>
    )
  }
];

export default function HowItWorks() {
  return (
    <div className="relative mt-16">
      {/* horizontal connector behind the badges (desktop only) */}
      <div className="pointer-events-none absolute inset-x-0 top-7 hidden h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent lg:block" />
      <ol className="grid gap-10 lg:grid-cols-4">
        {STAGES.map((s) => (
          <li key={s.title}>
            <div className="flex items-center gap-4 lg:block">
              <span className="relative z-10 grid h-14 w-14 shrink-0 place-items-center rounded-2xl border border-accent/30 bg-background text-accent shadow-[0_0_30px_-10px_var(--color-accent)]">
                {s.icon}
              </span>
              <div className="lg:mt-5">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-xs text-accent">{s.n}</span>
                  <h3 className="font-sans text-lg font-semibold text-text">{s.title}</h3>
                </div>
                <p className="mt-2 max-w-xs font-sans text-sm leading-relaxed text-muted">{s.body}</p>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
