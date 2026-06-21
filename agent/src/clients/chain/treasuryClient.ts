// Non-custodial treasury client: the bridge between the agent and the attested
// on-chain Treasury. It reads the vault's deployable budget + custodied positions from
// chain, asks the enclave's /decide endpoint how to split the budget (the enclave
// signs each leg), and builds the atomic multi-leg PTB the agent submits as Submitter.
//
// The agent's key NEVER holds the funds here — funds live in the Treasury, the agent
// only pays gas. The pure helpers (computeDeployable, parseTreasuryState,
// decodeReceiptProtocol, parseSignedLeg) are exported for unit testing.
import type { SuiClient } from '@mysten/sui/client';
import type { Transaction } from '@mysten/sui/transactions';
import type { ActionIntent } from '../../core/actionIntent.js';
import {
  type AllocationLeg,
  type AllocationRefs,
  buildVerifiedAllocationTx
} from '../../core/verifiedSupplyTx.js';

const PROTOCOL_NAME: Record<number, string> = { 0: 'suilend', 1: 'scallop', 2: 'navi', 255: 'mock' };

/** The on-chain `Treasury<T>` state that bounds what the agent may deploy. */
export interface TreasuryState {
  fundsRaw: bigint;
  perTxCapRaw: bigint;
  periodCapRaw: bigint;
  spentInPeriodRaw: bigint;
  periodStartMs: number;
  periodMs: number;
  expiryMs: number;
  /** The active AgentCap id, or null once the owner revoked the agent. */
  agentCapId: string | null;
  owner: string;
}

/** How much the agent may actually deploy right now, and why/why-not. */
export interface DeployableBudget {
  deployableRaw: bigint;
  remainingPeriodRaw: bigint;
  canSupply: boolean;
  reason?: string;
}

/** A protocol position custodied inside the Treasury (a receipt dynamic field). */
export interface CustodiedPosition {
  protocolId: number;
  protocol: string;
  receiptObjectId: string;
  receiptType: string;
}

// === Pure helpers (unit-tested) ===

/** Parse the `Treasury` object's content fields into typed state. */
export function parseTreasuryState(fields: Record<string, unknown>): TreasuryState {
  const big = (k: string): bigint => BigInt(String(fields[k] ?? 0));
  // Option<ID> serializes as null (none) or the id string (some).
  const agent = fields.agent;
  return {
    fundsRaw: big('funds'),
    perTxCapRaw: big('per_tx_cap'),
    periodCapRaw: big('period_cap'),
    spentInPeriodRaw: big('spent_in_period'),
    periodStartMs: Number(fields.period_start_ms ?? 0),
    periodMs: Number(fields.period_ms ?? 0),
    expiryMs: Number(fields.expiry_ms ?? 0),
    agentCapId: agent == null ? null : String(agent),
    owner: String(fields.owner ?? '')
  };
}

/**
 * Compute the deployable budget, mirroring the on-chain `release_for_action` checks:
 * agent not revoked, not expired, and `min(funds, period_cap - spent)` where `spent`
 * resets if the rolling window has elapsed.
 */
export function computeDeployable(state: TreasuryState, nowMs: number): DeployableBudget {
  const none = (reason: string): DeployableBudget => ({
    deployableRaw: 0n,
    remainingPeriodRaw: 0n,
    canSupply: false,
    reason
  });
  if (state.agentCapId === null) return none('agent revoked');
  if (nowMs >= state.expiryMs) return none('treasury expired');

  const rolled = nowMs >= state.periodStartMs + state.periodMs;
  const spent = rolled ? 0n : state.spentInPeriodRaw;
  const remainingPeriodRaw = state.periodCapRaw > spent ? state.periodCapRaw - spent : 0n;
  const deployableRaw = state.fundsRaw < remainingPeriodRaw ? state.fundsRaw : remainingPeriodRaw;

  if (deployableRaw <= 0n) {
    return {
      deployableRaw: 0n,
      remainingPeriodRaw,
      canSupply: false,
      reason: remainingPeriodRaw === 0n ? 'period budget exhausted' : 'no idle funds'
    };
  }
  return { deployableRaw, remainingPeriodRaw, canSupply: true };
}

/** Map a custodied receipt's type to its protocol (by the receipt struct name). */
export function decodeReceiptProtocol(receiptType: string): { protocolId: number; protocol: string } {
  if (receiptType.includes('ObligationOwnerCap')) return { protocolId: 0, protocol: 'suilend' };
  if (receiptType.includes('ScallopPosition')) return { protocolId: 1, protocol: 'scallop' };
  if (receiptType.includes('AccountCap')) return { protocolId: 2, protocol: 'navi' };
  if (receiptType.includes('MockPosition')) return { protocolId: 255, protocol: 'mock' };
  return { protocolId: -1, protocol: 'unknown' };
}

/** Rebuild a typed ActionIntent from the enclave's JSON-serialized intent, verbatim. */
export function parseSignedLeg(i: Record<string, unknown>): ActionIntent {
  const num = (v: unknown) => v as number[];
  return {
    schemaVersion: Number(i.schemaVersion),
    chainId: num(i.chainId),
    treasuryId: String(i.treasuryId),
    agentCapId: String(i.agentCapId),
    nonce: BigInt(i.nonce as string),
    expiresAtMs: BigInt(i.expiresAtMs as string),
    actionKind: Number(i.actionKind),
    protocolId: Number(i.protocolId),
    assetType: num(i.assetType),
    amount: BigInt(i.amount as string),
    minHealthFactorBps: BigInt(i.minHealthFactorBps as string),
    maxProtocolExposure: BigInt(i.maxProtocolExposure as string),
    policyHash: num(i.policyHash),
    inputHash: num(i.inputHash),
    rationaleHash: num(i.rationaleHash)
  };
}

// === Client ===

export interface TreasuryClientOptions {
  suiClient: SuiClient;
  /** Shared `Treasury<T>` object id. */
  treasuryId: string;
  /** The agent's `AgentCap<T>` object id. */
  agentCapId: string;
  /** Enclave base URL, e.g. http://<ip>:3000. */
  enclaveUrl: string;
  /** On-chain `Enclave<DECISION>` object id — its `pk` is the key the contract trusts. */
  enclaveId?: string;
  /** On-chain `EnclaveConfig` object id — holds the pinned PCR0/1/2/16 (code identity). */
  enclaveConfigId?: string;
  /** Injectable fetch (for tests). */
  fetchImpl?: typeof fetch;
}

/** The full attested response from the enclave's /decide. */
export interface DecideResult {
  legs: AllocationLeg[];
  /** The TEE's secp256k1 public key (matches the on-chain `Enclave<DECISION>.pk`). */
  publicKey: string;
  scheme: string;
  /** The water-filling allocation the enclave computed (per-protocol split + blended APR). */
  // biome-ignore lint/suspicious/noExplicitAny: enclave allocation passthrough
  allocation: any;
}

/** The TEE identity the contract enforces: the registered signing key + pinned PCR
 *  measurements (the code identity an attested enclave must match). */
export interface EnclaveAttestation {
  enclaveId: string;
  /** secp256k1 public key registered on-chain (`Enclave<DECISION>.pk`). */
  publicKeyHex: string;
  configId: string;
  configName: string;
  /** PCR0/1/2/16 from the on-chain `EnclaveConfig` (hex). Empty if no config id is set. */
  pcrs: { pcr0: string; pcr1: string; pcr2: string; pcr16: string };
}

/** Build a SuiVision explorer URL with the path matching the entity KIND. Sui distinguishes
 *  these and so does the explorer: a shared/owned object is /object/, a published package is
 *  /package/, a wallet/address is /account/, a coin type is /coin/, and a transaction is
 *  /txblock/ (NOT /object/). Passing the wrong kind yields a dead link. */
export function suivisionUrl(
  kind: 'object' | 'package' | 'account' | 'coin' | 'tx',
  id: string,
  network = 'mainnet'
): string {
  const host = network === 'mainnet' ? 'https://suivision.xyz' : `https://${network}.suivision.xyz`;
  return `${host}/${kind === 'tx' ? 'txblock' : kind}/${id}`;
}

/** Render a human-readable TEE attestation banner for demos/logs. `live` cross-checks the
 *  on-chain key against the `/decide` signer and appends the signed allocation legs. */
export function formatEnclaveAttestation(
  att: EnclaveAttestation,
  live?: {
    enclaveUrl?: string;
    decidePublicKey?: string;
    scheme?: string;
    network?: string;
    legs?: Array<{ protocol: string; amountRaw: string; nonce: string; signature: string }>;
  }
): string {
  const bar = '═'.repeat(72);
  const norm = (h: string) => h.replace(/^0x/, '').toLowerCase();
  const trunc = (h: string, head: number, tail: number) =>
    h.length > head + tail + 1 ? `${h.slice(0, head)}…${h.slice(-tail)}` : h;
  const out: string[] = [bar, '  TEE ATTESTATION — Marlin Oyster enclave (secp256k1)', bar];
  if (live?.enclaveUrl) out.push(`  enclave url     ${live.enclaveUrl}`);
  out.push(`  object (chain)  ${att.enclaveId}`);
  const match = live?.decidePublicKey
    ? norm(live.decidePublicKey) === norm(att.publicKeyHex)
      ? '   — matches /decide signer'
      : '   — MISMATCH vs /decide signer'
    : '';
  out.push(`  signing key     ${att.publicKeyHex}${match}`);
  if (att.configId) out.push(`  config          ${att.configName} (${trunc(att.configId, 10, 6)})`);
  if (att.pcrs.pcr0) {
    out.push(`  ${'─'.repeat(18)} PCRs · code identity pinned on-chain ${'─'.repeat(15)}`);
    out.push(`  PCR0  ${att.pcrs.pcr0 || '(not pinned)'}`);
    out.push(`  PCR1  ${att.pcrs.pcr1 || '(not pinned)'}`);
    out.push(`  PCR2  ${att.pcrs.pcr2 || '(not pinned)'}`);
    out.push(`  PCR16 ${att.pcrs.pcr16 || '(not pinned)'}`);
  }
  if (live?.legs?.length) {
    out.push(
      `  ${'─'.repeat(20)} signed allocation · scheme ${live.scheme || 'secp256k1'} ${'─'.repeat(12)}`
    );
    live.legs.forEach((l, i) => {
      out.push(
        `  leg ${i + 1}  ${l.protocol.toUpperCase().padEnd(8)} amount ${l.amountRaw.padStart(10)}  nonce ${trunc(l.nonce, 6, 4)}  sig ${trunc(l.signature, 14, 6)}`
      );
    });
  }
  const net = live?.network ?? 'mainnet';
  // Both the attested Enclave<DECISION> and its EnclaveConfig are on-chain OBJECTS → /object/.
  out.push(`  ${'─'.repeat(28)} explorer (SuiVision) ${'─'.repeat(22)}`);
  out.push(`  enclave  ${suivisionUrl('object', att.enclaveId, net)}`);
  if (att.configId) out.push(`  config   ${suivisionUrl('object', att.configId, net)}`);
  out.push(bar);
  return out.join('\n');
}

/** Render the post-submission confirmation. A successful `verified_supply` tx IS the proof
 *  the contract verified the TEE signature, adapter allow-list, nonce, and caps on-chain —
 *  and custodied the receipt in the Treasury. */
export function formatVerifiedSupplyResult(opts: {
  digest: string;
  network?: string;
  legs: Array<{ protocol: string; amount: string }>;
  oracleRefresh?: string | null;
}): string {
  const bar = '═'.repeat(72);
  const net = opts.network ?? 'mainnet';
  const out: string[] = [
    bar,
    '  ON-CHAIN VERIFICATION PASSED — allocation executed & custodied',
    bar,
    '  checks passed   enclave sig · adapter allow-list · nonce · caps',
    `  legs executed    ${opts.legs.length}  (${opts.legs.map((l) => `${l.protocol.toUpperCase()} ${l.amount}`).join(' · ')})`,
    '  receipts         custodied in Treasury — owner-only withdrawal'
  ];
  if (opts.oracleRefresh && opts.oracleRefresh !== 'none')
    out.push(`  oracle refresh   ${opts.oracleRefresh}`);
  out.push(`  tx               ${opts.digest}`);
  // A transaction is /txblock/ on SuiVision, not /object/.
  out.push(`  explorer         ${suivisionUrl('tx', opts.digest, net)}`);
  out.push(bar);
  return out.join('\n');
}

/** Render the on-chain treasury vault state: idle balance, deployable budget, caps, agent
 *  authority, and custodied positions — the "what the agent is allowed to do" snapshot. */
export function formatTreasuryStatus(opts: {
  treasuryId: string;
  state: TreasuryState;
  budget: DeployableBudget;
  positions?: Array<{ protocol: string }>;
  network?: string;
}): string {
  const bar = '═'.repeat(72);
  const usdc = (raw: bigint) =>
    `${(Number(raw) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 })} USDC`;
  const { state, budget } = opts;
  const pos = opts.positions ?? [];
  const net = opts.network ?? 'mainnet';
  const out: string[] = [
    bar,
    `  TREASURY VAULT — ${opts.treasuryId}`,
    bar,
    `  idle balance     ${usdc(state.fundsRaw)}`,
    `  deployable now   ${usdc(budget.deployableRaw)}${budget.canSupply ? '' : `   (cannot supply: ${budget.reason})`}`,
    `  per-tx cap       ${usdc(state.perTxCapRaw)}`,
    `  period cap       ${usdc(state.periodCapRaw)}   (remaining ${usdc(budget.remainingPeriodRaw)})`,
    `  agent            ${state.agentCapId ? `ACTIVE  (cap ${state.agentCapId.slice(0, 10)}…)` : 'REVOKED'}`,
    `  custodied        ${pos.length ? `${pos.map((p) => p.protocol.toUpperCase()).join(', ')}   (${pos.length} position${pos.length > 1 ? 's' : ''})` : 'none'}`,
    // The Treasury<T> and AgentCap<T> are on-chain OBJECTS → /object/.
    `  vault            ${suivisionUrl('object', opts.treasuryId, net)}`,
    ...(state.agentCapId ? [`  agent cap        ${suivisionUrl('object', state.agentCapId, net)}`] : []),
    bar
  ];
  return out.join('\n');
}

/** Market data + intent context the enclave needs to decide an allocation. */
export interface DecideRequest {
  // biome-ignore lint/suspicious/noExplicitAny: protocol reserve curves passed through to the enclave
  curves: any[];
  depositRaw: bigint;
  perTxCapRaw: bigint;
  nonce: bigint;
  expiresAtMs: bigint;
  assetType: number[];
  chainId: number[];
  timestampMs: bigint;
}

export class TreasuryClient {
  private readonly sui: SuiClient;
  private readonly fetchImpl: typeof fetch;
  readonly treasuryId: string;
  readonly agentCapId: string;
  readonly enclaveUrl: string;
  readonly enclaveId: string;
  readonly enclaveConfigId: string;

  constructor(opts: TreasuryClientOptions) {
    this.sui = opts.suiClient;
    this.treasuryId = opts.treasuryId;
    this.agentCapId = opts.agentCapId;
    this.enclaveUrl = opts.enclaveUrl.replace(/\/$/, '');
    this.enclaveId = opts.enclaveId ?? '';
    this.enclaveConfigId = opts.enclaveConfigId ?? '';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Read the TEE identity the contract enforces: the enclave's registered secp256k1 public
   * key (`Enclave<DECISION>.pk`) and the PCR0/1/2/16 measurements pinned in its `EnclaveConfig`
   * (the code identity). Returns null if no enclave object id is configured.
   */
  async readEnclaveAttestation(): Promise<EnclaveAttestation | null> {
    if (!this.enclaveId) return null;
    const enc = await this.sui.getObject({ id: this.enclaveId, options: { showContent: true } });
    // biome-ignore lint/suspicious/noExplicitAny: dynamic move content
    const ef = (enc.data?.content as any)?.fields;
    if (!ef?.pk) return null;
    const toHex = (a: number[]) => a.map((b) => b.toString(16).padStart(2, '0')).join('');
    const att: EnclaveAttestation = {
      enclaveId: this.enclaveId,
      publicKeyHex: `0x${toHex(ef.pk)}`,
      configId: this.enclaveConfigId,
      configName: '',
      pcrs: { pcr0: '', pcr1: '', pcr2: '', pcr16: '' }
    };
    if (this.enclaveConfigId) {
      const cfg = await this.sui.getObject({ id: this.enclaveConfigId, options: { showContent: true } });
      // biome-ignore lint/suspicious/noExplicitAny: dynamic move content
      const cf = (cfg.data?.content as any)?.fields;
      if (cf) {
        att.configName = cf.name ?? '';
        // `Pcrs` is a positional tuple `Pcrs(v,v,v,v)`, so the RPC names its elements
        // pos0..pos3. The 4th slot (pos3) holds the value registered as PCR16.
        const p = cf.pcrs?.fields ?? {};
        att.pcrs = {
          pcr0: toHex(p.pos0 ?? []),
          pcr1: toHex(p.pos1 ?? []),
          pcr2: toHex(p.pos2 ?? []),
          pcr16: toHex(p.pos3 ?? [])
        };
      }
    }
    return att;
  }

  /** Read the on-chain Treasury state (funds, caps, expiry, agent active/revoked). */
  async readState(): Promise<TreasuryState> {
    const o = await this.sui.getObject({ id: this.treasuryId, options: { showContent: true } });
    // biome-ignore lint/suspicious/noExplicitAny: dynamic move content
    const fields = (o.data?.content as any)?.fields;
    if (!fields) throw new Error(`treasury ${this.treasuryId} not found or has no content`);
    return parseTreasuryState(fields);
  }

  /** Deployable budget + canSupply, derived from on-chain state at `nowMs`. */
  async readBudget(nowMs: number): Promise<DeployableBudget & { state: TreasuryState }> {
    const state = await this.readState();
    return { ...computeDeployable(state, nowMs), state };
  }

  /** The protocol positions custodied inside the Treasury (one receipt per protocol). */
  async readPositions(): Promise<CustodiedPosition[]> {
    const res = await this.sui.getDynamicFields({ parentId: this.treasuryId });
    const out: CustodiedPosition[] = [];
    for (const f of res.data) {
      const { protocolId, protocol } = decodeReceiptProtocol(f.objectType);
      if (protocolId < 0) continue;
      out.push({ protocolId, protocol, receiptObjectId: f.objectId, receiptType: f.objectType });
    }
    return out;
  }

  /**
   * Ask the enclave to DECIDE the allocation. Returns the full attested response: one signed
   * leg per funded protocol PLUS the TEE's public key (verify it matches the on-chain
   * `Enclave<DECISION>.pk`) and the water-filling allocation it computed. Use `decideLegs` if
   * you only need the legs.
   */
  async decide(req: DecideRequest): Promise<DecideResult> {
    const body = {
      curves: req.curves,
      depositRaw: req.depositRaw.toString(),
      treasuryId: this.treasuryId,
      agentCapId: this.agentCapId,
      perTxCapRaw: req.perTxCapRaw.toString(),
      nonce: req.nonce.toString(),
      expiresAtMs: req.expiresAtMs.toString(),
      assetType: req.assetType,
      chainId: req.chainId,
      timestampMs: req.timestampMs.toString()
    };
    const res = await this.fetchImpl(`${this.enclaveUrl}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`enclave /decide failed: HTTP ${res.status}`);
    const json = (await res.json()) as {
      public_key?: string;
      scheme?: string;
      legs: Array<{ intent: Record<string, unknown>; signature: string }>;
      allocation?: unknown;
    };
    return {
      legs: json.legs.map((l) => ({ intent: parseSignedLeg(l.intent), signatureHex: l.signature })),
      publicKey: json.public_key ?? '',
      scheme: json.scheme ?? '',
      allocation: json.allocation
    };
  }

  /** Convenience: just the signed legs (drops the public key + allocation). */
  async decideLegs(req: DecideRequest): Promise<AllocationLeg[]> {
    return (await this.decide(req)).legs;
  }

  /**
   * Bundle the signed legs into ONE atomic PTB (one verified_supply_* command per leg).
   * Pass `tx` to append onto a transaction that already holds an oracle-refresh prelude
   * (e.g. Suilend's reserve refresh, which must precede its deposit in the same PTB).
   */
  buildSupplyTx(
    legs: AllocationLeg[],
    refs: AllocationRefs,
    timestampMs: bigint,
    tx?: Transaction
  ): Transaction {
    return buildVerifiedAllocationTx(legs, refs, timestampMs, tx);
  }

  /** Convenience: the protocol name for a protocol id. */
  static protocolName(protocolId: number): string {
    return PROTOCOL_NAME[protocolId] ?? 'unknown';
  }
}
