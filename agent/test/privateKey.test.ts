import { describe, expect, test } from 'bun:test';
import { describeSuiPrivateKeyConfig, normalizeSuiPrivateKey } from '../src/utils/privateKey.js';

describe('normalizeSuiPrivateKey', () => {
  test('accepts 64-char hex with 0x prefix', () => {
    const key = `0x${'ab'.repeat(32)}`;
    expect(normalizeSuiPrivateKey(key)).toBe(key.toLowerCase());
  });

  test('accepts 64-char hex without prefix', () => {
    const body = 'ab'.repeat(32);
    expect(normalizeSuiPrivateKey(body)).toBe(`0x${body}`);
  });

  test('rejects invalid hex', () => {
    expect(() => normalizeSuiPrivateKey('0x1234')).toThrow();
  });
});

describe('describeSuiPrivateKeyConfig', () => {
  test('reports empty key', () => {
    expect(describeSuiPrivateKeyConfig('')).toEqual({
      configured: false,
      valid: false,
      hint: 'Set AGENT_SUI_PRIVATE_KEY to a suiprivkey or hex private key.'
    });
  });
});
