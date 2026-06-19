import { describe, expect, test } from 'bun:test';
import { formatUnits, parseUnits } from '../src/utils/amounts.js';

describe('amount helpers', () => {
  test('formatUnits formats integer and fractional units', () => {
    expect(formatUnits('1000000', 6)).toBe('1');
    expect(formatUnits('1234567', 6)).toBe('1.234567');
    expect(formatUnits('1200000', 6)).toBe('1.2');
  });

  test('parseUnits parses decimal strings', () => {
    expect(parseUnits('1', 6)).toBe(1000000n);
    expect(parseUnits('1.25', 6)).toBe(1250000n);
    expect(parseUnits('0.000001', 6)).toBe(1n);
  });
});
