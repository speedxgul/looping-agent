'use client';

import {
  useConnectWallet,
  useCurrentAccount,
  useDisconnectWallet,
  useWallets
} from '@mysten/dapp-kit';
import { useEffect, useRef, useState } from 'react';

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

export default function ConnectWallet() {
  const wallets = useWallets();
  const account = useCurrentAccount();
  const { mutate: connect, isPending } = useConnectWallet();
  const { mutate: disconnect } = useDisconnectWallet();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Avoid hydration mismatch: render a stable placeholder until mounted.
  if (!mounted) {
    return (
      <button
        type="button"
        className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-black"
      >
        Connect Wallet
      </button>
    );
  }

  if (account) {
    return (
      <div className="relative" ref={ref}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-full border border-accent/40 bg-accent/10 px-4 py-2 text-sm font-semibold text-accent transition-colors hover:bg-accent/20"
        >
          {short(account.address)}
        </button>
        {open && (
          <div className="absolute right-0 z-50 mt-2 w-44 overflow-hidden rounded-xl border border-border bg-panel shadow-xl">
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(account.address);
                setOpen(false);
              }}
              className="block w-full px-4 py-2.5 text-left text-sm text-text hover:bg-panel-2"
            >
              Copy address
            </button>
            <button
              type="button"
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
              className="block w-full px-4 py-2.5 text-left text-sm text-red-400 hover:bg-panel-2"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={isPending}
        className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-black shadow-[0_0_24px_-6px_var(--color-accent)] transition-transform hover:scale-[1.03] disabled:opacity-60"
      >
        {isPending ? 'Connecting…' : 'Connect Wallet'}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl border border-border bg-panel shadow-xl">
          <div className="border-b border-border px-4 py-2.5 text-xs uppercase tracking-wider text-muted">
            Select a wallet
          </div>
          {wallets.length === 0 ? (
            <div className="px-4 py-4 text-sm text-muted">
              No Sui wallets detected. Install{' '}
              <a
                href="https://phantom.app/download"
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                Phantom
              </a>{' '}
              to continue.
            </div>
          ) : (
            wallets.map((wallet) => (
              <button
                key={wallet.name}
                type="button"
                onClick={() =>
                  connect(
                    { wallet },
                    {
                      onSuccess: () => setOpen(false)
                    }
                  )
                }
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-text hover:bg-panel-2"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {wallet.icon ? (
                  <img src={wallet.icon} alt="" className="h-5 w-5 rounded" />
                ) : (
                  <span className="h-5 w-5 rounded bg-panel-2" />
                )}
                {wallet.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
