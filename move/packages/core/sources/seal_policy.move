/// Seal access policy: release key-shares only to the attested enclave. Follows the
/// Nautilus + Seal pattern — the requester proves it is the registered enclave by
/// signing a WalletPK-scoped IntentMessage with the enclave key (PCR-bound at
/// register_enclave time). Gates decryption of the enclave's Seal-encrypted signing
/// seed / strategy weights.
module treasury_core::seal_policy;

use enclave::enclave::{Self, Enclave};

/// Intent scope for the Seal wallet-key request (distinct from DECISION_INTENT = 0).
const WALLET_PK_INTENT: u8 = 1;

#[error]
const EWrongKeyId: vector<u8> = b"Seal key id must be vector[0]";
#[error]
const EUnauthorized: vector<u8> = b"Request is not signed by the registered enclave";

/// Seal calls this (dry-run) before releasing key-shares; it ABORTS to deny access.
/// TODO(seal): also bind ctx.sender() to the address derived from wallet_pk (anti-replay).
public fun seal_approve<T>(
    id: vector<u8>,
    enclave: &Enclave<T>,
    timestamp_ms: u64,
    wallet_pk: vector<u8>,
    signature: vector<u8>,
) {
    assert!(id == vector[0], EWrongKeyId);
    assert!(
        enclave.verify_signature(WALLET_PK_INTENT, timestamp_ms, wallet_pk, &signature),
        EUnauthorized,
    );
}

// === Tests ===
#[test_only]
public struct WITNESS has drop {}

#[test]
fun seal_approve_grants_attested() {
    let mut ctx = tx_context::dummy();
    let pk = x"034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
    let e = enclave::new_enclave_for_testing<WITNESS>(pk, &mut ctx);
    let sig = x"f096a4c7219f5241190b5f61094a02fdbac5f2307b8e8fb5140b92bba74d71f51ea6e92cc541cafc1078314e6bf187c1839d5f3ff12bcabee9bc36291c0a37e9";
    // wallet_pk = ascii("WALLET-PK-DEMO")
    seal_approve<WITNESS>(vector[0], &e, 1_700_000_000_000, b"WALLET-PK-DEMO", sig);
    e.destroy();
}

#[test, expected_failure(abort_code = EWrongKeyId)]
fun seal_approve_wrong_key_id_aborts() {
    let mut ctx = tx_context::dummy();
    let pk = x"034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
    let e = enclave::new_enclave_for_testing<WITNESS>(pk, &mut ctx);
    let sig = x"f096a4c7219f5241190b5f61094a02fdbac5f2307b8e8fb5140b92bba74d71f51ea6e92cc541cafc1078314e6bf187c1839d5f3ff12bcabee9bc36291c0a37e9";
    seal_approve<WITNESS>(vector[1], &e, 1_700_000_000_000, b"WALLET-PK-DEMO", sig); // wrong id
    e.destroy();
    abort
}

#[test, expected_failure(abort_code = EUnauthorized)]
fun seal_approve_tampered_aborts() {
    let mut ctx = tx_context::dummy();
    let pk = x"034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
    let e = enclave::new_enclave_for_testing<WITNESS>(pk, &mut ctx);
    let sig = x"f096a4c7219f5241190b5f61094a02fdbac5f2307b8e8fb5140b92bba74d71f51ea6e92cc541cafc1078314e6bf187c1839d5f3ff12bcabee9bc36291c0a37e9";
    seal_approve<WITNESS>(vector[0], &e, 1_700_000_000_000, b"WRONG-WALLET-PK", sig); // tampered payload
    e.destroy();
    abort
}
