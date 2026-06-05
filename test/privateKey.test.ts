import { describe, expect, test } from 'bun:test';
import { describePrivateKeyConfig, normalizePrivateKey } from '../src/utils/privateKey.js';

describe('normalizePrivateKey', () => {
  test('accepts 0x-prefixed hex', () => {
    const key = '0x' + '11'.repeat(32);
    expect(normalizePrivateKey(key)).toBe(key);
  });

  test('accepts hex without prefix', () => {
    const body = '22'.repeat(32);
    expect(normalizePrivateKey(body)).toBe(`0x${body}`);
  });

  test('rejects mnemonic-like values', () => {
    expect(() => normalizePrivateKey('word1 word2 word3')).toThrow(/mnemonic/i);
  });

  test('rejects wallet address length', () => {
    expect(() => normalizePrivateKey('0x' + 'ab'.repeat(20))).toThrow(/64 hex/i);
  });

  test('accepts 32 comma-separated hex byte pairs', () => {
    const bytes = Array.from({ length: 32 }, (_, i) => (i + 1).toString(16).padStart(2, '0'));
    expect(normalizePrivateKey(bytes.join(','))).toBe(`0x${bytes.join('')}`);
  });

  test('accepts comma-separated bytes with 0x prefix on first segment only', () => {
    const body = '11'.repeat(32);
    const comma = body.match(/.{2}/g)!.join(',');
    expect(normalizePrivateKey(`0x${comma}`)).toBe(`0x${body}`);
  });

  test('accepts 32 comma-separated decimal bytes', () => {
    const decimals = Array.from({ length: 32 }, (_, i) => String(i));
    const hex = decimals.map((n) => Number(n).toString(16).padStart(2, '0')).join('');
    expect(normalizePrivateKey(decimals.join(','))).toBe(`0x${hex}`);
  });

  test('accepts 64 digit-only hex string', () => {
    const body = '0'.repeat(64);
    expect(normalizePrivateKey(body)).toBe(`0x${body}`);
  });
});

describe('describePrivateKeyConfig', () => {
  test('reports empty key', () => {
    expect(describePrivateKeyConfig('')).toEqual({
      configured: false,
      valid: false,
      hint: 'Set AGENT_PRIVATE_KEY to a 0x-prefixed hex key for the wallet owner.'
    });
  });
});
