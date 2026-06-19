export function formatUnits(raw: string | bigint, decimals: number): string {
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = value % scale;

  if (fraction === 0n) {
    return whole.toString();
  }

  const padded = fraction.toString().padStart(decimals, '0');
  const trimmed = padded.replace(/0+$/, '');
  return `${whole}.${trimmed}`;
}

export function parseUnits(value: string | number, decimals: number): bigint {
  const [wholePart, fractionPart = ''] = String(value).split('.');
  const normalizedFraction = fractionPart.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(wholePart || '0') * 10n ** BigInt(decimals) + BigInt(normalizedFraction || '0');
}

export function bpsToPercent(bps: number): number {
  return Number(bps) / 100;
}
