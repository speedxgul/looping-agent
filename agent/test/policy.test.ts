import { describe, expect, test } from 'bun:test';
import { evaluateActionPolicy } from '../src/core/policy.js';
import { baseConfig } from './fixtures/baseConfig.js';

describe('evaluateActionPolicy', () => {
  test('allows suilend supply for allowlisted assets under cap', () => {
    const result = evaluateActionPolicy(
      {
        type: 'SUILEND_SUPPLY',
        details: {
          asset: 'usdc',
          rawAmount: '1000'
        }
      },
      baseConfig()
    );

    expect(result).toEqual({ allowed: true, reason: 'allowed' });
  });

  test('blocks suilend supply above the configured cap', () => {
    const result = evaluateActionPolicy(
      {
        type: 'SUILEND_SUPPLY',
        details: {
          asset: 'usdc',
          rawAmount: '1001'
        }
      },
      baseConfig({ runtime: { dryRun: false, nodeEnv: 'test', autonomyIntervalMs: 1000 } })
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Requested amount exceeds SUI_MAX_SUPPLY_AMOUNT_RAW');
  });

  test('blocks borrow when projected health factor is too low', () => {
    const result = evaluateActionPolicy(
      {
        type: 'SUILEND_BORROW',
        details: {
          asset: 'usdc',
          rawAmount: '1000',
          projectedHealthFactor: 1.1
        }
      },
      baseConfig({ sui: { ...baseConfig().sui, enableBorrow: true } })
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Borrow would push health factor below SUI_MIN_HEALTH_FACTOR (1.25)');
  });
});
