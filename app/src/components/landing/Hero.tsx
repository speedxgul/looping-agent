import Link from 'next/link';
import HeroCanvas from './HeroCanvas';

export default function Hero() {
  return (
    <section className="relative flex min-h-[calc(100vh-4rem)] items-center justify-center overflow-hidden">
      <HeroCanvas />

      {/* vignette + bottom fade so content stays readable */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(10,14,20,0.7)_100%)]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-background to-transparent" />

      <div className="relative z-10 mx-auto max-w-3xl px-6 text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-4 py-1.5 font-sans text-xs font-medium uppercase tracking-widest text-accent">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          Live on Sui mainnet
        </span>

        <h1 className="mt-8 font-sans text-6xl font-semibold tracking-tight text-text sm:text-8xl">
          Autonomous
          <br />
          <span className="bg-gradient-to-r from-accent via-emerald-300 to-teal-200 bg-clip-text text-transparent">
            Yield
          </span>
        </h1>

        <p className="mx-auto mt-6 max-w-xl font-sans text-base text-muted sm:text-lg">
          A non-custodial agent that deploys idle stablecoins into verifiable on-chain yield under
          risk bounds you can cryptographically check. The model plans; deterministic code moves the
          funds.
        </p>

        <div className="mt-10 flex items-center justify-center gap-4">
          <Link
            href="/app"
            className="rounded-full bg-accent px-7 py-3 font-sans text-sm font-semibold text-black shadow-[0_0_40px_-8px_var(--color-accent)] transition-transform hover:scale-[1.04]"
          >
            Launch App
          </Link>
          <a
            href="#how"
            className="rounded-full border border-border px-7 py-3 font-sans text-sm font-medium text-text transition-colors hover:border-accent/50 hover:text-accent"
          >
            Learn more
          </a>
        </div>
      </div>
    </section>
  );
}
