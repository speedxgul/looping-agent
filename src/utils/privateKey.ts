import type { Hex } from 'viem';

export function normalizePrivateKey(raw: string): Hex | '' {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.includes(',')) {
    const fromComma = parseCommaSeparatedPrivateKey(trimmed);
    if (fromComma) {
      return `0x${fromComma}` as Hex;
    }
  }

  if (hasWhitespaceOutsideCommas(trimmed)) {
    throw new Error(
      'AGENT_PRIVATE_KEY looks like a mnemonic or phrase. Export a hex key (bun derive-key.ts "word1 ...") or set a 0x-prefixed 64-character hex private key.'
    );
  }

  const withoutPrefix = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed.slice(2) : trimmed;

  if (/^[0-9]+$/.test(withoutPrefix) && withoutPrefix.length !== 64) {
    throw new Error(
      `AGENT_PRIVATE_KEY has ${withoutPrefix.length} decimal digits; need 64 hex digits (0-9, a-f) or 32 comma-separated byte values (0-255).`
    );
  }

  const body = withoutPrefix;
  if (!/^[0-9a-fA-F]{64}$/.test(body)) {
    throw new Error(
      'AGENT_PRIVATE_KEY must be exactly 32 bytes: 64 hex characters (0-9 and a-f), or 32 comma-separated bytes (hex pairs or decimal 0-255).'
    );
  }

  return `0x${body.toLowerCase()}` as Hex;
}

function hasWhitespaceOutsideCommas(value: string): boolean {
  return /[\s\n\r\t]/.test(value.replace(/,/g, ''));
}

function parseCommaSeparatedPrivateKey(raw: string): string | null {
  const normalized = raw.replace(/^0x/i, '');
  const parts = normalized
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  if (parts.length === 32) {
    const segments = parts.map((part) => part.replace(/^0x/i, ''));
    const useDecimal = preferDecimalByteEncoding(segments);
    return segments.map((part) => (useDecimal ? parseDecimalByte(part) : parseHexByte(part))).join('');
  }

  const joined = parts.map((part) => part.replace(/^0x/i, '')).join('');
  if (/^[0-9a-fA-F]{64}$/.test(joined)) {
    return joined.toLowerCase();
  }

  return null;
}

function preferDecimalByteEncoding(segments: string[]): boolean {
  if (segments.some((segment) => /[a-fA-F]/.test(segment))) {
    return false;
  }

  // Two-digit groups like 11,22,ff are treated as hex byte pairs.
  if (segments.every((segment) => /^\d{2}$/.test(segment))) {
    return false;
  }

  return segments.every((segment) => /^\d{1,3}$/.test(segment));
}

function parseHexByte(segment: string): string {
  if (!/^[0-9a-fA-F]{1,2}$/i.test(segment)) {
    throw new Error(
      'Each comma-separated AGENT_PRIVATE_KEY segment must be a hex byte (00-ff) or decimal byte (0-255).'
    );
  }

  return segment.padStart(2, '0').toLowerCase();
}

function parseDecimalByte(segment: string): string {
  const value = Number(segment);
  if (!/^\d{1,3}$/.test(segment) || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(
      'AGENT_PRIVATE_KEY decimal byte values must be integers from 0 to 255 (32 values comma-separated).'
    );
  }

  return value.toString(16).padStart(2, '0');
}

export function describePrivateKeyConfig(raw: string): { configured: boolean; valid: boolean; hint?: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { configured: false, valid: false, hint: 'Set AGENT_PRIVATE_KEY to a 0x-prefixed hex key for the wallet owner.' };
  }

  try {
    normalizePrivateKey(trimmed);
    return { configured: true, valid: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { configured: true, valid: false, hint: message };
  }
}
