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
  /** Injectable fetch (for tests). */
  fetchImpl?: typeof fetch;
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

  constructor(opts: TreasuryClientOptions) {
    this.sui = opts.suiClient;
    this.treasuryId = opts.treasuryId;
    this.agentCapId = opts.agentCapId;
    this.enclaveUrl = opts.enclaveUrl.replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
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

  /** Ask the enclave to DECIDE the allocation; returns one signed leg per funded protocol. */
  async decide(req: DecideRequest): Promise<AllocationLeg[]> {
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
      legs: Array<{ intent: Record<string, unknown>; signature: string }>;
    };
    return json.legs.map((l) => ({ intent: parseSignedLeg(l.intent), signatureHex: l.signature }));
  }

  /** Bundle the signed legs into ONE atomic PTB (one verified_supply_* command per leg). */
  buildSupplyTx(legs: AllocationLeg[], refs: AllocationRefs, timestampMs: bigint): Transaction {
    return buildVerifiedAllocationTx(legs, refs, timestampMs);
  }

  /** Convenience: the protocol name for a protocol id. */
  static protocolName(protocolId: number): string {
    return PROTOCOL_NAME[protocolId] ?? 'unknown';
  }
}
