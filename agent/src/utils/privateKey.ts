import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

export function normalizeSuiPrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('suiprivkey')) {
    Ed25519Keypair.fromSecretKey(trimmed);
    return trimmed;
  }

  const withoutPrefix = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(withoutPrefix)) {
    throw new Error(
      'AGENT_SUI_PRIVATE_KEY must be a suiprivkey bech32 string or 64 hex characters (optionally 0x-prefixed).'
    );
  }

  return `0x${withoutPrefix.toLowerCase()}`;
}

export function createSuiKeypair(privateKey: string): Ed25519Keypair {
  if (!privateKey) {
    throw new Error('AGENT_SUI_PRIVATE_KEY is not configured');
  }

  if (privateKey.startsWith('suiprivkey')) {
    return Ed25519Keypair.fromSecretKey(privateKey);
  }

  const hex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  return Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(hex, 'hex')));
}

export function deriveSuiAddress(privateKey: string): string {
  return createSuiKeypair(privateKey).toSuiAddress();
}

export function describeSuiPrivateKeyConfig(raw: string): {
  configured: boolean;
  valid: boolean;
  hint?: string;
} {
  if (!raw.trim()) {
    return {
      configured: false,
      valid: false,
      hint: 'Set AGENT_SUI_PRIVATE_KEY to a suiprivkey or hex private key.'
    };
  }

  try {
    normalizeSuiPrivateKey(raw);
    return { configured: true, valid: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { configured: true, valid: false, hint: message };
  }
}
