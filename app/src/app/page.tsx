import Link from 'next/link';
import Hero from '@/components/landing/Hero';
import TopNav from '@/components/TopNav';

const FEATURES = [
  {
    title: 'TEE-attested decisions',
    body: 'The optimizer runs and signs every allocation inside a TEE (Nautilus + Marlin Oyster); its key is PCR-bound on-chain. The agent can’t puppet the venue or amount, and a tampered intent is rejected.'
  },
  {
    title: 'Non-custodial & bounded',
    body: 'Funds live in an on-chain Treasury; the agent holds only a capped, revocable AgentCap and can never withdraw. Per-tx and rolling caps, allowlists, and health-factor gates are enforced in code — never the model.'
  },
  {
    title: 'Two decision engines',
    body: 'A flexible LLM tool-calling agent and a deterministic six-subagent yield-looping pipeline — both move funds only through the same policy.'
  },
  {
    title: 'Multi-protocol & auditable',
    body: 'Reads and writes across Suilend, NAVI, and Scallop via an own-impact-aware optimizer; every proposal, plan, and receipt is archived to Walrus.'
  }
];

const STATS = [
  { label: 'Lending protocols', value: '3' },
  { label: 'Autonomous subagents', value: '6' },
  { label: 'LLM in fund path', value: 'None' },
  { label: 'Network', value: 'Sui' }
];

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <TopNav variant="landing" />
      <Hero />

      <section id="how" className="mx-auto max-w-7xl px-6 py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-sans text-3xl font-semibold tracking-tight text-text sm:text-4xl">
            Built to move funds safely
          </h2>
          <p className="mt-4 font-sans text-muted">
            Autonomous decision-making is separated from protocol access, with all risk enforcement
            in deterministic code.
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border border-border bg-gradient-to-b from-panel to-panel-2 p-6 transition-colors hover:border-accent/40"
            >
              <h3 className="font-sans text-lg font-semibold text-text">{f.title}</h3>
              <p className="mt-3 font-sans text-sm leading-relaxed text-muted">{f.body}</p>
            </div>
          ))}
        </div>

        <div className="mt-20 grid grid-cols-2 gap-4 rounded-3xl border border-border bg-panel/40 p-8 sm:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.label} className="text-center">
              <div className="bg-gradient-to-r from-accent to-emerald-300 bg-clip-text font-sans text-4xl font-semibold text-transparent">
                {s.value}
              </div>
              <div className="mt-2 font-sans text-xs uppercase tracking-wider text-muted">
                {s.label}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-20 flex flex-col items-center gap-6 rounded-3xl border border-accent/30 bg-gradient-to-br from-accent/10 to-transparent px-8 py-16 text-center">
          <h2 className="font-sans text-3xl font-semibold tracking-tight text-text sm:text-4xl">
            Watch it work
          </h2>
          <p className="max-w-xl font-sans text-muted">
            Open the trust console to see live market rates, positions, strategy proposals, execution
            receipts, and the agent&apos;s reasoning in real time.
          </p>
          <Link
            href="/app"
            className="rounded-full bg-accent px-8 py-3 font-sans text-sm font-semibold text-black shadow-[0_0_40px_-8px_var(--color-accent)] transition-transform hover:scale-[1.04]"
          >
            Launch App
          </Link>
        </div>
      </section>

      <footer className="border-t border-border py-8 text-center font-sans text-xs text-muted">
        Non-custodial treasury agent on Sui · read-only trust console
      </footer>
    </div>
  );
}
