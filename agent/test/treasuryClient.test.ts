import { describe, expect, it } from 'bun:test';
import {
  computeDeployable,
  decodeReceiptProtocol,
  parseSignedLeg,
  parseTreasuryState,
  type TreasuryState
} from '../src/clients/chain/treasuryClient.js';

const DAY = 86_400_000;

const baseState: TreasuryState = {
  fundsRaw: 1_000_000n,
  perTxCapRaw: 100_000n,
  periodCapRaw: 300_000n,
  spentInPeriodRaw: 0n,
  periodStartMs: 1_000_000,
  periodMs: DAY,
  expiryMs: 9_999_999_999_999,
  agentCapId: '0xagent',
  owner: '0xowner'
};

describe('parseTreasuryState', () => {
  it('parses Move content fields (Balance as string value, Option<ID> as id|null)', () => {
    const s = parseTreasuryState({
      funds: '150000000',
      per_tx_cap: '100000000',
      period_cap: '150000000',
      period_ms: '86400000',
      expiry_ms: '9999999999999',
      spent_in_period: '50000000',
      period_start_ms: '1781974495204',
      agent: '0x6443',
      owner: '0x2cdd'
    });
    expect(s.fundsRaw).toBe(150_000_000n);
    expect(s.perTxCapRaw).toBe(100_000_000n);
    expect(s.spentInPeriodRaw).toBe(50_000_000n);
    expect(s.agentCapId).toBe('0x6443');
  });

  it('treats a null agent (revoked) as null', () => {
    expect(parseTreasuryState({ agent: null }).agentCapId).toBeNull();
  });
});

describe('computeDeployable', () => {
  const now = baseState.periodStartMs + 1000; // within the period window

  it('deployable = min(funds, remaining period budget) within the window', () => {
    const b = computeDeployable({ ...baseState, spentInPeriodRaw: 100_000n }, now);
    // remaining period = 300k - 100k = 200k; funds 1M -> min = 200k
    expect(b.remainingPeriodRaw).toBe(200_000n);
    expect(b.deployableRaw).toBe(200_000n);
    expect(b.canSupply).toBe(true);
  });

  it('is capped by funds when funds < remaining period budget', () => {
    const b = computeDeployable({ ...baseState, fundsRaw: 50_000n }, now);
    expect(b.deployableRaw).toBe(50_000n); // funds < 300k remaining
  });

  it('resets spent_in_period once the rolling window has elapsed', () => {
    const afterWindow = baseState.periodStartMs + DAY + 1;
    const b = computeDeployable({ ...baseState, spentInPeriodRaw: 300_000n }, afterWindow);
    // window rolled -> spent treated as 0 -> remaining = full period cap
    expect(b.remainingPeriodRaw).toBe(300_000n);
    expect(b.deployableRaw).toBe(300_000n);
  });

  it('cannot supply when the period budget is exhausted (same window)', () => {
    const b = computeDeployable({ ...baseState, spentInPeriodRaw: 300_000n }, now);
    expect(b.deployableRaw).toBe(0n);
    expect(b.canSupply).toBe(false);
    expect(b.reason).toBe('period budget exhausted');
  });

  it('cannot supply when the agent is revoked', () => {
    const b = computeDeployable({ ...baseState, agentCapId: null }, now);
    expect(b.canSupply).toBe(false);
    expect(b.reason).toBe('agent revoked');
  });

  it('cannot supply when the treasury has expired', () => {
    const b = computeDeployable({ ...baseState, expiryMs: now - 1 }, now);
    expect(b.canSupply).toBe(false);
    expect(b.reason).toBe('treasury expired');
  });

  it('cannot supply with no idle funds', () => {
    const b = computeDeployable({ ...baseState, fundsRaw: 0n }, now);
    expect(b.canSupply).toBe(false);
    expect(b.reason).toBe('no idle funds');
  });
});

describe('decodeReceiptProtocol', () => {
  it('maps each receipt struct to its protocol id', () => {
    expect(
      decodeReceiptProtocol('0x79::suilend::lending_market::ObligationOwnerCap<0x..::MAIN_POOL>')
    ).toEqual({ protocolId: 0, protocol: 'suilend' });
    expect(decodeReceiptProtocol('0x79::scallop_adapter::ScallopPosition<0x2::sui::SUI>')).toEqual({
      protocolId: 1,
      protocol: 'scallop'
    });
    expect(decodeReceiptProtocol('0xd8::account::AccountCap')).toEqual({ protocolId: 2, protocol: 'navi' });
    expect(decodeReceiptProtocol('0x79::mock_supply::MockPosition<0x2::sui::SUI>')).toEqual({
      protocolId: 255,
      protocol: 'mock'
    });
    expect(decodeReceiptProtocol('0x2::coin::Coin<...>')).toEqual({ protocolId: -1, protocol: 'unknown' });
  });
});

describe('parseSignedLeg', () => {
  it('rebuilds a typed ActionIntent from the enclave-serialized intent', () => {
    const intent = parseSignedLeg({
      schemaVersion: 1,
      chainId: [4],
      treasuryId: '0x1',
      agentCapId: '0x2',
      nonce: '5',
      expiresAtMs: '9999999999999',
      actionKind: 0,
      protocolId: 255,
      assetType: [83],
      amount: '20000000',
      minHealthFactorBps: '0',
      maxProtocolExposure: '0',
      policyHash: Array(32).fill(0),
      inputHash: Array(32).fill(0),
      rationaleHash: Array(32).fill(0)
    });
    expect(intent.nonce).toBe(5n);
    expect(intent.amount).toBe(20_000_000n);
    expect(intent.protocolId).toBe(255);
    expect(intent.chainId).toEqual([4]);
  });
});
