import { describe, expect, it } from 'bun:test';
import {
  buildAllocationRefs,
  hasRefFor,
  treasuryToolDefinitions,
  treasuryToolHandlers
} from '../src/core/treasuryTools.js';
import type { Clients, Logger } from '../src/types.js';
import { baseConfig } from './fixtures/baseConfig.js';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

describe('treasuryToolDefinitions', () => {
  it('exposes exactly the three treasury tools', () => {
    expect(treasuryToolDefinitions().map((d) => d.name)).toEqual([
      'get_treasury_status',
      'get_treasury_positions',
      'treasury_supply'
    ]);
  });
});

describe('buildAllocationRefs', () => {
  it('is mock-only when no protocols are configured', () => {
    const refs = buildAllocationRefs(baseConfig(), '0xTreasury', '0xAgentCap');
    expect(refs.mock).toBeDefined();
    expect(refs.suilend).toBeUndefined();
    expect(refs.scallop).toBeUndefined();
    expect(refs.navi).toBeUndefined();
    expect(hasRefFor(refs, 255)).toBe(true); // mock always submittable
    expect(hasRefFor(refs, 1)).toBe(false); // scallop not configured
  });

  it('adds a real protocol once its shared-object ids are configured', () => {
    const cfg = baseConfig();
    cfg.treasury.protocols.scallop = { versionId: '0xVersion', marketId: '0xMarket' };
    const refs = buildAllocationRefs(cfg, '0xTreasury', '0xAgentCap');
    expect(refs.scallop?.versionId).toBe('0xVersion');
    expect(refs.scallop?.marketId).toBe('0xMarket');
    expect(hasRefFor(refs, 1)).toBe(true); // scallop now submittable
    expect(hasRefFor(refs, 0)).toBe(false); // suilend still not configured
  });
});

describe('treasuryToolHandlers', () => {
  it('registers no handlers when there is no TreasuryClient (flag off / unconfigured)', () => {
    const handlers = treasuryToolHandlers({
      config: baseConfig(),
      clients: { treasury: null } as unknown as Clients,
      logger: noopLogger
    });
    expect(Object.keys(handlers)).toHaveLength(0);
  });
});
