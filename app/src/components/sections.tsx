import {
  Badge,
  EmptyState,
  Panel,
  ProtocolTag,
  StatusDot,
  Table,
  Td,
  Th
} from './ui';
import {
  assetSymbol,
  bpsToPct,
  formatApr,
  formatHealthFactor,
  formatRawAmount,
  formatTokenQty,
  formatUsd,
  isStale,
  shortAddr,
  timeAgo,
  txUrl
} from '@/lib/format';
import { SUBAGENT_ROLES } from '@/lib/types';
import type {
  AcceptedPlan,
  AgentStateV1,
  ExecutionReceipt,
  LoopStrategyProposal,
  PlanStatus,
  ProposalStatus,
  StrategyLedgerV1,
  SubagentHeartbeat,
  SubagentStatus
} from '@/lib/types';

const STALE_HEARTBEAT_MS = 5 * 60 * 1000;

type Tone = 'ok' | 'warn' | 'error' | 'muted' | 'info' | 'critical';

function subagentTone(status: SubagentStatus): Tone {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'running':
      return 'info';
    case 'error':
      return 'error';
    case 'idle':
      return 'warn';
    default:
      return 'muted';
  }
}

function hfTone(hf: number | undefined): Tone {
  if (hf === undefined || !Number.isFinite(hf)) return 'ok';
  if (hf < 1.1) return 'critical';
  if (hf < 1.3) return 'warn';
  return 'ok';
}

function proposalTone(status: ProposalStatus): Tone {
  switch (status) {
    case 'accepted':
      return 'ok';
    case 'open':
      return 'info';
    case 'rejected':
      return 'error';
    default:
      return 'muted';
  }
}

function planTone(status: PlanStatus): Tone {
  switch (status) {
    case 'executed':
      return 'ok';
    case 'executing':
    case 'accepted':
      return 'info';
    case 'failed':
      return 'error';
    default:
      return 'muted';
  }
}

export function SubagentHealth({
  subagents,
  now
}: {
  subagents: Record<string, SubagentHeartbeat>;
  now: number;
}) {
  return (
    <Panel title="Subagent Health" subtitle="6-role pipeline">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {SUBAGENT_ROLES.map((role) => {
          const hb = subagents[role];
          const enabled = hb?.enabled ?? false;
          const stale = enabled && isStale(hb?.heartbeatAt, STALE_HEARTBEAT_MS, now);
          const tone: Tone = !enabled ? 'muted' : stale ? 'warn' : subagentTone(hb.status);
          return (
            <div
              key={role}
              className="flex flex-col gap-1 rounded-md border border-border bg-panel-2 px-3 py-2"
            >
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm font-medium text-text">
                  <StatusDot tone={tone} />
                  {role}
                </span>
                <Badge tone={tone}>{!enabled ? 'disabled' : hb.status}</Badge>
              </div>
              <div className="flex items-center justify-between text-xs text-muted">
                <span>{enabled ? timeAgo(hb?.heartbeatAt, now) : 'not running'}</span>
                {stale && <span className="text-amber-400">stale</span>}
              </div>
              {hb?.message && <p className="truncate text-xs text-muted">{hb.message}</p>}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export function MarketRates({ ledger, now }: { ledger: StrategyLedgerV1; now: number }) {
  const snapshot = ledger.marketSnapshots[0];
  const rates = [...(snapshot?.rates ?? [])].sort(
    (a, b) => a.asset.localeCompare(b.asset) || a.protocol.localeCompare(b.protocol)
  );
  return (
    <Panel
      title="Market Rates"
      count={rates.length}
      subtitle={snapshot ? `captured ${timeAgo(snapshot.capturedAt, now)}` : undefined}
    >
      {rates.length === 0 ? (
        <EmptyState>No market snapshot recorded yet.</EmptyState>
      ) : (
        <Table
          head={
            <>
              <Th>Asset</Th>
              <Th>Protocol</Th>
              <Th right>Supply APR</Th>
              <Th right>Borrow APR</Th>
              <Th right>Price</Th>
              <Th right>Liquidity</Th>
            </>
          }
        >
          {rates.map((r) => (
            <tr key={`${r.protocol}-${r.coinType}`} className="border-b border-border/50">
              <Td>{r.asset}</Td>
              <Td>
                <ProtocolTag protocol={r.protocol} />
              </Td>
              <Td right mono>
                <span className="text-emerald-400">{formatApr(r.supplyApr)}</span>
              </Td>
              <Td right mono>
                <span className="text-amber-400">{formatApr(r.borrowApr)}</span>
              </Td>
              <Td right mono>
                {formatUsd(r.priceUsd)}
              </Td>
              <Td right mono>
                {r.liquidityUsd !== undefined ? formatUsd(r.liquidityUsd) : '—'}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

export function Positions({ ledger, now }: { ledger: StrategyLedgerV1; now: number }) {
  const snapshot = ledger.positionSnapshots[0];
  const protocols = snapshot?.protocols ?? [];
  const active = protocols.filter(
    (p) => p.depositedAmountUsd > 0 || p.borrowedAmountUsd > 0
  );

  // Position-snapshot leg `rawAmount` is normalized inconsistently across
  // protocols (NAVI uses 1e9 even for USDC; Suilend/Scallop store human units).
  // Derive the token quantity from amountUsd / price using the latest market
  // snapshot prices instead, which is protocol-agnostic and correct.
  const rates = ledger.marketSnapshots[0]?.rates ?? [];
  const priceByCoin = new Map<string, number>();
  const priceBySymbol = new Map<string, number>();
  for (const r of rates) {
    if (r.priceUsd > 0) {
      priceByCoin.set(r.coinType.toLowerCase(), r.priceUsd);
      priceBySymbol.set(r.asset.toUpperCase(), r.priceUsd);
    }
  }
  const legQty = (leg: { coinType: string; asset: string; amountUsd: number }): number | undefined => {
    const price =
      priceByCoin.get(leg.coinType.toLowerCase()) ??
      priceBySymbol.get(assetSymbol(leg.asset)) ??
      (/usd[ct]/i.test(leg.asset) ? 1 : undefined);
    if (price === undefined || price <= 0) return undefined;
    return leg.amountUsd / price;
  };
  return (
    <Panel
      title="Positions"
      subtitle={snapshot ? `captured ${timeAgo(snapshot.capturedAt, now)}` : undefined}
    >
      {active.length === 0 ? (
        <EmptyState>No open positions in the latest snapshot.</EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {active.map((p) => (
            <div key={p.protocol} className="rounded-md border border-border bg-panel-2 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold capitalize text-text">{p.protocol}</span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  HF
                  <Badge tone={hfTone(p.healthFactor)}>{formatHealthFactor(p.healthFactor)}</Badge>
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-muted sm:grid-cols-4">
                <div>
                  <div className="uppercase tracking-wider">Deposited</div>
                  <div className="text-sm text-emerald-400">{formatUsd(p.depositedAmountUsd)}</div>
                </div>
                <div>
                  <div className="uppercase tracking-wider">Borrowed</div>
                  <div className="text-sm text-amber-400">{formatUsd(p.borrowedAmountUsd)}</div>
                </div>
                <div>
                  <div className="uppercase tracking-wider">Borrow Limit</div>
                  <div className="text-sm text-text">{formatUsd(p.borrowLimitUsd)}</div>
                </div>
                <div>
                  <div className="uppercase tracking-wider">Wtd Borrows</div>
                  <div className="text-sm text-text">{formatUsd(p.weightedBorrowsUsd)}</div>
                </div>
              </div>
              {(p.deposits.length > 0 || p.borrows.length > 0) && (
                <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                  {p.deposits.map((d, i) => (
                    <Badge key={`d-${i}`} tone="ok">
                      +{formatTokenQty(legQty(d))} {assetSymbol(d.asset)}
                    </Badge>
                  ))}
                  {p.borrows.map((b, i) => (
                    <Badge key={`b-${i}`} tone="warn">
                      -{formatTokenQty(legQty(b))} {assetSymbol(b.asset)}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function LoopPositions({ ledger, now }: { ledger: StrategyLedgerV1; now: number }) {
  const positions = ledger.loopPositions ?? [];

  // The loop position's rawCollateralAmount can be a protocol-normalized leg
  // amount (NAVI uses 1e9 even for USDC), so scaling by token decimals is
  // unreliable. Use the originating proposal's collateralUsd instead.
  const collateralUsdByProposal = new Map<string, number>();
  for (const proposal of ledger.strategyProposals) {
    if (typeof proposal.collateralUsd === 'number') {
      collateralUsdByProposal.set(proposal.id, proposal.collateralUsd);
    }
  }
  const usdcPrice =
    ledger.marketSnapshots[0]?.rates.find((r) => r.asset.toUpperCase() === 'USDC' && r.priceUsd > 0)
      ?.priceUsd ?? 1;

  return (
    <Panel title="Loop Positions" count={positions.length}>
      {positions.length === 0 ? (
        <EmptyState>No yield-loop positions opened.</EmptyState>
      ) : (
        <Table
          head={
            <>
              <Th>Status</Th>
              <Th>Collateral → Supply</Th>
              <Th right>Collateral</Th>
              <Th right>Borrow</Th>
              <Th right>Depth</Th>
              <Th right>Opened</Th>
            </>
          }
        >
          {positions.map((p) => {
            const collateralUsd = collateralUsdByProposal.get(p.proposalId);
            const collateralQty = collateralUsd !== undefined ? collateralUsd / usdcPrice : undefined;
            return (
            <tr key={p.id} className="border-b border-border/50">
              <Td>
                <Badge tone={p.status === 'active' ? 'ok' : p.status === 'closed' ? 'muted' : 'info'}>
                  {p.status}
                </Badge>
              </Td>
              <Td>
                <span className="capitalize">{p.collateralProtocol}</span>
                <span className="text-muted"> → </span>
                <span className="capitalize">{p.supplyTargetProtocol}</span>
              </Td>
              <Td right mono>
                {collateralQty !== undefined
                  ? formatTokenQty(collateralQty)
                  : formatRawAmount(p.rawCollateralAmount, p.collateralAsset)}{' '}
                {p.collateralAsset}
              </Td>
              <Td right mono>
                {formatRawAmount(p.rawBorrowAmount, p.borrowAsset)} {p.borrowAsset}
              </Td>
              <Td right mono>
                {p.depth}
              </Td>
              <Td right>{timeAgo(p.openedAt, now)}</Td>
            </tr>
            );
          })}
        </Table>
      )}
    </Panel>
  );
}

export function Proposals({
  proposals,
  now
}: {
  proposals: LoopStrategyProposal[];
  now: number;
}) {
  const recent = [...proposals]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 12);
  return (
    <Panel title="Strategy Proposals" count={proposals.length}>
      {recent.length === 0 ? (
        <EmptyState>No strategy proposals.</EmptyState>
      ) : (
        <Table
          head={
            <>
              <Th>Status</Th>
              <Th>Type</Th>
              <Th>By</Th>
              <Th right>Collateral</Th>
              <Th right>Borrow</Th>
              <Th right>Net APR</Th>
              <Th right>Proj. HF</Th>
              <Th right>Created</Th>
            </>
          }
        >
          {recent.map((p) => (
            <tr key={p.id} className="border-b border-border/50 align-top">
              <Td>
                <Badge tone={proposalTone(p.status)}>{p.status}</Badge>
              </Td>
              <Td>{p.proposalType === 'open_loop' ? 'open loop' : 'borrow vs collat'}</Td>
              <Td>{p.proposerRole}</Td>
              <Td right mono>
                {formatUsd(p.collateralUsd)}
              </Td>
              <Td right mono>
                {formatUsd(p.borrowUsd)}
              </Td>
              <Td right mono>
                {bpsToPct(p.netAprBps ?? p.projectedNetAprBps)}
              </Td>
              <Td right mono>
                {formatHealthFactor(p.projectedHealthFactor)}
              </Td>
              <Td right>{timeAgo(p.createdAt, now)}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

export function PlansAndReceipts({
  plans,
  receipts,
  now
}: {
  plans: AcceptedPlan[];
  receipts: ExecutionReceipt[];
  now: number;
}) {
  const receiptById = new Map(receipts.map((r) => [r.id, r]));
  const recent = [...plans]
    .sort((a, b) => new Date(b.acceptedAt).getTime() - new Date(a.acceptedAt).getTime())
    .slice(0, 10);
  return (
    <Panel title="Plans & Execution Receipts" count={plans.length}>
      {recent.length === 0 ? (
        <EmptyState>No accepted plans yet.</EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {recent.map((plan) => {
            const receipt = plan.executionReceiptId
              ? receiptById.get(plan.executionReceiptId)
              : undefined;
            return (
              <div key={plan.id} className="rounded-md border border-border bg-panel-2 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <Badge tone={planTone(plan.status)}>{plan.status}</Badge>
                    {receipt?.dryRun && <Badge tone="info">dry-run</Badge>}
                    {!plan.policy.allowed && <Badge tone="error">policy blocked</Badge>}
                  </span>
                  <span className="text-xs text-muted">accepted {timeAgo(plan.acceptedAt, now)}</span>
                </div>
                {plan.failureReason && (
                  <p className="mt-1 text-xs text-red-400">{plan.failureReason}</p>
                )}
                {!plan.policy.allowed && plan.policy.reason && (
                  <p className="mt-1 text-xs text-muted">policy: {plan.policy.reason}</p>
                )}
                {receipt && (
                  <div className="mt-2 border-t border-border/60 pt-2">
                    <div className="mb-1 flex items-center gap-3 text-xs text-muted">
                      <span>
                        HF {formatHealthFactor(receipt.beforeHealthFactor)} →{' '}
                        {formatHealthFactor(receipt.afterHealthFactor)}
                      </span>
                      <span>status {receipt.status}</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      {receipt.legs.map((leg, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs">
                          <Badge tone={leg.status === 'confirmed' ? 'ok' : leg.status === 'failed' ? 'error' : 'muted'}>
                            {leg.action}
                          </Badge>
                          <span className="capitalize text-muted">{leg.protocol}</span>
                          <span className="tabular-nums">
                            {formatRawAmount(leg.rawAmount, leg.asset)} {leg.asset}
                          </span>
                          {leg.digest && (
                            <a
                              href={txUrl(leg.digest)}
                              target="_blank"
                              rel="noreferrer"
                              className="text-blue-400 hover:underline"
                            >
                              {shortAddr(leg.digest, 6, 4)} ↗
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                    {receipt.error && <p className="mt-1 text-xs text-red-400">{receipt.error}</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

export function RiskLocks({ ledger, now }: { ledger: StrategyLedgerV1; now: number }) {
  const active = ledger.riskLocks.filter((l) => l.active);
  const cleared = ledger.riskLocks.filter((l) => !l.active).slice(0, 5);
  return (
    <Panel title="Risk Locks" count={active.length}>
      {active.length === 0 && cleared.length === 0 ? (
        <EmptyState>No risk locks recorded.</EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          {active.length === 0 && <EmptyState>No active risk locks. System nominal.</EmptyState>}
          {active.map((lock) => (
            <div
              key={lock.id}
              className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2"
            >
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Badge tone={lock.severity === 'critical' ? 'critical' : 'warn'}>
                    {lock.severity}
                  </Badge>
                  <span className="text-sm text-text">{lock.role}</span>
                </span>
                <span className="text-xs text-muted">{timeAgo(lock.createdAt, now)}</span>
              </div>
              <p className="mt-1 text-xs text-muted">{lock.reason}</p>
            </div>
          ))}
          {cleared.map((lock) => (
            <div
              key={lock.id}
              className="flex items-center justify-between rounded-md border border-border bg-panel-2 px-3 py-2 text-xs text-muted"
            >
              <span className="flex items-center gap-2">
                <Badge tone="muted">cleared</Badge>
                {lock.role}: {lock.reason}
              </span>
              <span>{lock.clearedAt ? timeAgo(lock.clearedAt, now) : ''}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function WalrusArchives({ ledger, now }: { ledger: StrategyLedgerV1; now: number }) {
  const archives = (ledger.walrusArchives ?? []).slice(0, 10);
  return (
    <Panel title="Walrus Archives" count={ledger.walrusArchives?.length ?? 0} subtitle="verifiable history">
      {archives.length === 0 ? (
        <EmptyState>No records archived to Walrus.</EmptyState>
      ) : (
        <Table
          head={
            <>
              <Th>Kind</Th>
              <Th>Record</Th>
              <Th>Blob</Th>
              <Th right>Created</Th>
            </>
          }
        >
          {archives.map((a) => (
            <tr key={`${a.blobId}-${a.recordId}`} className="border-b border-border/50">
              <Td>{a.kind.replace(/_/g, ' ')}</Td>
              <Td mono>{shortAddr(a.recordId, 8, 4)}</Td>
              <Td>
                <a
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-400 hover:underline"
                >
                  {shortAddr(a.blobId, 8, 6)} ↗
                </a>
              </Td>
              <Td right>{timeAgo(a.createdAt, now)}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}

export function AgentMemory({ memory, now }: { memory: AgentStateV1; now: number }) {
  const runs = [...memory.runs]
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, 5);
  const actions = [...memory.actions.positionActions]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 8);
  return (
    <Panel title="Main-Agent Memory" subtitle={memory.agentName || undefined}>
      {memory.pending.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {memory.pending.map((task, i) => (
            <Badge key={i} tone={task.type === 'health_alert' ? 'critical' : 'warn'}>
              {task.type.replace(/_/g, ' ')}
              {task.healthFactor !== undefined ? ` · HF ${formatHealthFactor(task.healthFactor)}` : ''}
            </Badge>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-[11px] uppercase tracking-wider text-muted">Recent Runs</h3>
          {runs.length === 0 ? (
            <EmptyState>No runs recorded.</EmptyState>
          ) : (
            <div className="flex flex-col gap-2">
              {runs.map((run) => (
                <div key={run.runId} className="rounded-md border border-border bg-panel-2 px-3 py-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted">{timeAgo(run.startedAt, now)}</span>
                    <Badge tone={run.endedAt ? 'ok' : 'info'}>{run.endedAt ? 'done' : 'running'}</Badge>
                  </div>
                  {run.summary && (
                    <p className="mt-1 line-clamp-3 text-xs text-text">{run.summary}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-[11px] uppercase tracking-wider text-muted">Recent Actions</h3>
          {actions.length === 0 ? (
            <EmptyState>No position actions recorded.</EmptyState>
          ) : (
            <Table
              head={
                <>
                  <Th>Action</Th>
                  <Th>Asset</Th>
                  <Th right>Amount</Th>
                  <Th right>When</Th>
                </>
              }
            >
              {actions.map((a) => (
                <tr key={a.id} className="border-b border-border/50">
                  <Td>
                    <span className="flex items-center gap-1.5">
                      <Badge
                        tone={a.status === 'confirmed' ? 'ok' : a.status === 'failed' ? 'error' : 'muted'}
                      >
                        {a.action}
                      </Badge>
                      {a.dryRun && <Badge tone="info">dry</Badge>}
                    </span>
                  </Td>
                  <Td>
                    <span className="capitalize text-muted">{a.protocol}</span> {assetSymbol(a.asset)}
                  </Td>
                  <Td right mono>
                    {formatRawAmount(a.rawAmount, a.asset)} {assetSymbol(a.asset)}
                  </Td>
                  <Td right>
                    {a.digest ? (
                      <a
                        href={txUrl(a.digest)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-400 hover:underline"
                      >
                        {timeAgo(a.createdAt, now)} ↗
                      </a>
                    ) : (
                      timeAgo(a.createdAt, now)
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      </div>
    </Panel>
  );
}

function HighlightCard({
  title,
  accent = 'teal',
  children
}: {
  title: string;
  accent?: 'teal' | 'violet' | 'blue' | 'amber';
  children: React.ReactNode;
}) {
  const ring: Record<string, string> = {
    teal: 'from-accent/15',
    violet: 'from-violet-500/15',
    blue: 'from-blue-500/15',
    amber: 'from-amber-500/15'
  };
  const dot: Record<string, string> = {
    teal: 'bg-accent',
    violet: 'bg-violet-400',
    blue: 'bg-blue-400',
    amber: 'bg-amber-400'
  };
  return (
    <div
      className={`rounded-2xl border border-border bg-gradient-to-b ${ring[accent]} to-panel-2 p-4`}
    >
      <div className="mb-3 flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${dot[accent]}`} />
        <h3 className="font-sans text-xs font-semibold uppercase tracking-wider text-muted">
          {title}
        </h3>
      </div>
      {children}
    </div>
  );
}

function CardRow({
  left,
  right,
  rightTone
}: {
  left: React.ReactNode;
  right: React.ReactNode;
  rightTone?: 'ok' | 'warn' | 'muted';
}) {
  const toneClass =
    rightTone === 'ok' ? 'text-emerald-400' : rightTone === 'warn' ? 'text-amber-400' : 'text-text';
  return (
    <div className="flex items-center justify-between py-1 font-sans text-sm">
      <span className="truncate text-muted">{left}</span>
      <span className={`tabular-nums font-medium ${toneClass}`}>{right}</span>
    </div>
  );
}

export function HighlightCards({
  ledger,
  memory
}: {
  ledger: StrategyLedgerV1;
  memory: AgentStateV1;
}) {
  void memory;
  const pos = ledger.positionSnapshots[0]?.protocols ?? [];
  const totalDeposited = pos.reduce((s, p) => s + (p.depositedAmountUsd || 0), 0);
  const totalBorrowed = pos.reduce((s, p) => s + (p.borrowedAmountUsd || 0), 0);
  const minHf = pos
    .filter((p) => p.borrowedAmountUsd > 0)
    .reduce<number | undefined>((min, p) => {
      if (!Number.isFinite(p.healthFactor)) return min;
      return min === undefined ? p.healthFactor : Math.min(min, p.healthFactor);
    }, undefined);

  const topSupply = [...(ledger.marketSnapshots[0]?.rates ?? [])]
    .sort((a, b) => b.supplyApr - a.supplyApr)
    .slice(0, 3);

  const topLoops = [...ledger.strategyProposals]
    .sort(
      (a, b) =>
        (b.netAprBps ?? b.projectedNetAprBps ?? 0) - (a.netAprBps ?? a.projectedNetAprBps ?? 0)
    )
    .slice(0, 3);

  const subagentList = Object.values(ledger.subagents);
  const okCount = subagentList.filter((s) => s.enabled && s.status === 'ok').length;
  const activeLocks = ledger.riskLocks.filter((l) => l.active).length;
  const activeLoops = ledger.loopPositions.filter((l) => l.status === 'active').length;

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      <HighlightCard title="Top Supply APY" accent="teal">
        {topSupply.length === 0 ? (
          <p className="font-sans text-sm text-muted">No market data.</p>
        ) : (
          topSupply.map((r) => (
            <CardRow
              key={`${r.protocol}-${r.coinType}`}
              left={
                <>
                  <span className="text-text">{r.asset}</span>{' '}
                  <span className="capitalize">{r.protocol}</span>
                </>
              }
              right={formatApr(r.supplyApr)}
              rightTone="ok"
            />
          ))
        )}
      </HighlightCard>

      <HighlightCard title="Best Loop Net APR" accent="violet">
        {topLoops.length === 0 ? (
          <p className="font-sans text-sm text-muted">No proposals yet.</p>
        ) : (
          topLoops.map((p) => (
            <CardRow
              key={p.id}
              left={
                <>
                  <span className="capitalize">{p.collateralProtocol}</span>
                  <span className="text-muted"> → </span>
                  <span className="capitalize">{p.supplyTargetProtocol}</span>
                </>
              }
              right={bpsToPct(p.netAprBps ?? p.projectedNetAprBps)}
              rightTone="ok"
            />
          ))
        )}
      </HighlightCard>

      <HighlightCard title="Treasury Positions" accent="blue">
        <CardRow left="Deposited" right={formatUsd(totalDeposited)} rightTone="ok" />
        <CardRow left="Borrowed" right={formatUsd(totalBorrowed)} rightTone="warn" />
        <CardRow
          left="Min Health Factor"
          right={minHf === undefined ? '∞' : formatHealthFactor(minHf)}
          rightTone={hfTone(minHf) === 'ok' ? 'ok' : 'warn'}
        />
      </HighlightCard>

      <HighlightCard title="Pipeline Health" accent="amber">
        <CardRow
          left="Subagents OK"
          right={`${okCount} / ${subagentList.length}`}
          rightTone={okCount === subagentList.length ? 'ok' : 'warn'}
        />
        <CardRow left="Active loops" right={activeLoops} />
        <CardRow
          left="Risk locks"
          right={activeLocks}
          rightTone={activeLocks > 0 ? 'warn' : 'ok'}
        />
      </HighlightCard>
    </div>
  );
}
