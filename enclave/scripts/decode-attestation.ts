// Decode a Nitro attestation document (hex) and print its public_key + PCRs.
// The :1301 attestation binds the enclave's secp256k1 signing key; :1300 only has
// the Oyster base's ed25519 identity key. Use this to confirm the key BEFORE you
// spend gas registering on-chain.
//
// Usage:  curl -s http://<ENCLAVE_IP>:1301/attestation/hex | bun run enclave/scripts/decode-attestation.ts
const hex = (await Bun.stdin.text()).trim().replace(/^0x/, '');
const buf = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));

// Minimal CBOR reader (enough for COSE_Sign1 + the attestation payload map).
function makeReader(bytes: Uint8Array) {
  let p = 0;
  function read(): any {
    const ib = bytes[p++];
    const major = ib >> 5;
    let len = ib & 0x1f;
    if (len >= 24 && len <= 27) {
      const k = len === 24 ? 1 : len === 25 ? 2 : len === 26 ? 4 : 8;
      let n = 0;
      for (let i = 0; i < k; i++) n = n * 256 + bytes[p++];
      len = n;
    }
    switch (major) {
      case 0: return len; // uint
      case 1: return -1 - len; // negative
      case 2: { const b = bytes.slice(p, p + len); p += len; return b; } // byte string
      case 3: { const s = new TextDecoder().decode(bytes.slice(p, p + len)); p += len; return s; } // text
      case 4: { const a = []; for (let i = 0; i < len; i++) a.push(read()); return a; } // array
      case 5: { const m = new Map(); for (let i = 0; i < len; i++) { const k = read(); m.set(k, read()); } return m; } // map
      case 6: return read(); // tag -> unwrap (COSE_Sign1 tag 18)
      case 7: return len === 20 ? false : len === 21 ? true : len === 22 ? null : len;
    }
  }
  return read;
}

const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const cose = makeReader(buf)(); // [protected, unprotected, payload(bstr), signature]
const doc = makeReader(cose[2] as Uint8Array)() as Map<string, any>;

const pk = doc.get('public_key');
const ud = doc.get('user_data');
const pcrs = doc.get('pcrs') as Map<number, Uint8Array>;

console.log('module_id :', doc.get('module_id'));
if (pk instanceof Uint8Array) {
  console.log(`public_key: len=${pk.length}  ${toHex(pk)}`);
  const verdict =
    pk.length === 64 || pk.length === 65 ? 'SECP256K1 (uncompressed) ✓ register_enclave will accept'
    : pk.length === 33 ? 'SECP256K1 (compressed) ✓'
    : pk.length === 32 ? 'ED25519 (Oyster base key) ✗ NOT the signing key — are you on :1301 not :1300?'
    : `unexpected length ${pk.length}`;
  console.log('  ->', verdict);
} else {
  console.log('public_key: <empty/none>  ✗');
}
console.log('user_data :', ud instanceof Uint8Array ? `len=${ud.length} ${toHex(ud)}` : (ud ?? '<empty>'));
if (pcrs) for (const idx of [0, 1, 2, 16]) { const v = pcrs.get(idx); if (v) console.log(`PCR${idx}: ${toHex(v)}`); }
