import Link from 'next/link';
import ConnectWallet from './ConnectWallet';

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2">
      <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-accent to-emerald-300 text-black">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2">
          <path d="M4 14c4-8 12-8 16 0" strokeLinecap="round" />
          <circle cx="12" cy="10" r="2.2" fill="currentColor" stroke="none" />
        </svg>
      </span>
      <span className="font-sans text-base font-semibold tracking-tight text-text">HexLiquid Yield</span>
    </Link>
  );
}

export default function TopNav({ variant = 'app' }: { variant?: 'landing' | 'app' }) {
  return (
    <nav className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-8">
          <Logo />
          <div className="hidden items-center gap-6 font-sans text-sm text-muted md:flex">
            <Link href="/app" className="transition-colors hover:text-text">
              Dashboard
            </Link>
            <a
              href="https://github.com"
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-text"
            >
              Docs
            </a>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {variant === 'landing' && (
            <Link
              href="/app"
              className="hidden rounded-full border border-border px-4 py-2 font-sans text-sm font-medium text-text transition-colors hover:border-accent/50 hover:text-accent sm:inline-block"
            >
              Launch App
            </Link>
          )}
          <ConnectWallet />
        </div>
      </div>
    </nav>
  );
}
