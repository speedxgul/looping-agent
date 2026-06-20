import { describe, expect, it } from 'bun:test';
import { treasuryToolDefinitions, treasuryToolHandlers } from '../src/core/treasuryTools.js';
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
