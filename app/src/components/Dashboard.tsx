'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AgentMemory,
  LoopPositions,
  MarketRates,
  Overview,
  PlansAndReceipts,
  Positions,
  Proposals,
  RiskLocks,
  SubagentHealth,
  WalrusArchives
} from './sections';
import { StatusDot } from './ui';
import { isStale, shortAddr, timeAgo } from '@/lib/format';
import type { AgentStateV1, StrategyLedgerV1 } from '@/lib/types';

const REFRESH_MS = 15_000;
const LEDGER_STALE_MS = 5 * 60 * 1000;

interface DashboardData {
  ledger: StrategyLedgerV1;
  ledgerOk: boolean;
  memory: AgentStateV1;
  memoryOk: boolean;
}

export default function Dashboard({
  initial,
  serverNow
}: {
  initial: DashboardData;
  serverNow: number;
}) {
  const [data, setData] = useState<DashboardData>(initial);
  // Seed time state from a single server-provided timestamp so the first
  // client render matches the server-rendered HTML (avoids hydration drift in
  // relative-time labels). After mount, the effect below switches to live time.
  const [now, setNow] = useState<number>(serverNow);
  const [refreshing, setRefreshing] = useState(false);
  const [lastFetched, setLastFetched] = useState<number>(serverNow);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [ledgerRes, memoryRes] = await Promise.all([
        fetch('/api/ledger', { cache: 'no-store' }),
        fetch('/api/memory', { cache: 'no-store' })
      ]);
      const ledgerJson = await ledgerRes.json();
      const memoryJson = await memoryRes.json();
      if (!mounted.current) return;
      setData({
        ledger: ledgerJson.data,
        ledgerOk: ledgerJson.ok,
        memory: memoryJson.data,
        memoryOk: memoryJson.ok
      });
      setLastFetched(Date.now());
      setError(null);
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : 'Failed to refresh');
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    setNow(Date.now());
    const poll = setInterval(refresh, REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [refresh]);

  const { ledger, ledgerOk, memory } = data;
  const ledgerStale = isStale(ledger.updatedAt, LEDGER_STALE_MS, now);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <Header
        ledger={ledger}
        memory={memory}
        now={now}
        ledgerOk={ledgerOk}
        ledgerStale={ledgerStale}
        refreshing={refreshing}
        lastFetched={lastFetched}
        error={error}
        onRefresh={refresh}
      />

      <div className="mt-4">
        <Overview ledger={ledger} memory={memory} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4">
        <SubagentHealth subagents={ledger.subagents} now={now} />

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <MarketRates ledger={ledger} now={now} />
          <Positions ledger={ledger} now={now} />
        </div>

        <RiskLocks ledger={ledger} now={now} />

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Proposals proposals={ledger.strategyProposals} now={now} />
          <LoopPositions ledger={ledger} now={now} />
        </div>

        <PlansAndReceipts
          plans={ledger.acceptedPlans}
          receipts={ledger.executionReceipts}
          now={now}
        />

        <AgentMemory memory={memory} now={now} />

        <WalrusArchives ledger={ledger} now={now} />
      </div>

      <footer className="mt-8 border-t border-border pt-4 text-center text-xs text-muted">
        Read-only trust console · data refreshes every {REFRESH_MS / 1000}s · the agent moves funds,
        this console only observes.
      </footer>
    </div>
  );
}

function Header({
  ledger,
  memory,
  now,
  ledgerOk,
  ledgerStale,
  refreshing,
  lastFetched,
  error,
  onRefresh
}: {
  ledger: StrategyLedgerV1;
  memory: AgentStateV1;
  now: number;
  ledgerOk: boolean;
  ledgerStale: boolean;
  refreshing: boolean;
  lastFetched: number;
  error: string | null;
  onRefresh: () => void;
}) {
  const wallet = ledger.walletAddress || memory.walletAddress;
  const tone = !ledgerOk ? 'error' : ledgerStale ? 'warn' : 'ok';
  const statusLabel = !ledgerOk ? 'no data' : ledgerStale ? 'stale' : 'live';

  return (
    <header className="flex flex-col gap-3 rounded-lg border border-border bg-panel/60 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-bold text-text">
          {memory.agentName || 'Treasury Agent'}
          <span className="rounded bg-blue-500/10 px-2 py-0.5 text-xs font-normal text-blue-400">
            Trust Console
          </span>
        </h1>
        <p className="mt-1 text-xs text-muted">
          wallet <span className="text-text">{shortAddr(wallet, 10, 6)}</span>
          {' · '}ledger updated {timeAgo(ledger.updatedAt, now)}
        </p>
      </div>

      <div className="flex items-center gap-4">
        <span className="flex items-center gap-2 text-sm">
          <StatusDot tone={tone} />
          <span
            className={
              tone === 'ok'
                ? 'text-emerald-400'
                : tone === 'warn'
                  ? 'text-amber-400'
                  : 'text-red-400'
            }
          >
            {statusLabel}
          </span>
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="rounded border border-border bg-panel-2 px-3 py-1.5 text-xs text-text transition-colors hover:border-blue-500/40 hover:text-blue-400 disabled:opacity-50"
        >
          {refreshing ? 'refreshing…' : `refreshed ${timeAgo(new Date(lastFetched).toISOString(), now)}`}
        </button>
      </div>
      {error && (
        <p className="text-xs text-red-400 sm:absolute">{error}</p>
      )}
    </header>
  );
}
