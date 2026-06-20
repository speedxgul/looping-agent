// Generates secp256k1 test vectors for Move `seal_policy.move` seal_approve test.
// BCS-encodes IntentMessage{intent: 1 (WALLET_PK_INTENT), timestamp_ms, payload: vector<u8>}
// then signs with the canonical dev key (0x11*32).
//
// `secp256k1.sign` prehashes with sha256 by default — matching Move's
// `ecdsa_k1::secp256k1_verify(.., 1)`.
//
// Run: bun run scripts/gen-wallet-pk-vector.ts

import { bcs } from '@mysten/sui/bcs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const PRIV = hexToBytes('11'.repeat(32));

// BCS schema: IntentMessage where payload is vector<u8> (matches Move's vector<u8> wallet_pk)
const IntentMessage = bcs.struct('IntentMessage', {
  intent: bcs.u8(),
  timestamp_ms: bcs.u64(),
  payload: bcs.vector(bcs.u8())
});

const walletPk = Array.from(new TextEncoder().encode('WALLET-PK-DEMO'));

const msg = IntentMessage.serialize({
  intent: 1,
  timestamp_ms: 1_700_000_000_000n,
  payload: walletPk
}).toBytes();

const sig = secp256k1.sign(msg, PRIV);
const signature = sig instanceof Uint8Array ? sig : (sig as { toBytes(): Uint8Array }).toBytes();

console.log('pk        =', bytesToHex(secp256k1.getPublicKey(PRIV, true)));
console.log('signature =', bytesToHex(signature));
console.log('wallet_pk =', bytesToHex(Uint8Array.from(walletPk)), '(= ascii WALLET-PK-DEMO)');
