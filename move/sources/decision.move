/// Attested execution: gate a bounded fund release on a decision signed by the
/// registered TEE enclave. This is the third trust layer, in front of the
/// capability's own bounds (capability.move) — no single layer is trusted.
///
/// Flow: the enclave (Nitro, registered via `enclave::register_enclave`) signs a
/// `DecisionPayload` with its secp256k1 key; on-chain we reconstruct the exact
/// BCS envelope, verify the signature against the registered key, and only then
/// release the bounded amount from the treasury.
module treasury_agent::decision;

use enclave::enclave::{Self, Enclave};
use sui::clock::Clock;
use sui::coin::Coin;
use sui::table::{Self, Table};
use treasury_agent::capability::{Self, AgentCap, Treasury};

/// Domain separator so an enclave signature for one app can't be replayed in another.
const DECISION_INTENT: u8 = 0;

#[error]
const EInvalidSignature: vector<u8> = b"Decision is not signed by the registered enclave";
#[error]
const EReplayedOrStaleNonce: vector<u8> = b"Decision nonce was already consumed or is stale (replay)";

/// One-time witness binding the registered `Enclave<DECISION>` to this app.
public struct DECISION has drop {}

/// What the enclave signs: authorize releasing `amount` from `treasury`.
/// `nonce` gives per-cycle replay protection. Field order/types here MUST match
/// the enclave's BCS serialization exactly.
public struct DecisionPayload has copy, drop {
    treasury: ID,
    amount: u64,
    nonce: u64,
}

/// Tracks the highest decision nonce consumed per treasury, so a single enclave
/// signature can be executed at most once (replay / double-release protection).
public struct DecisionRegistry has key {
    id: UID,
    last_nonce: Table<ID, u64>,
}

fun init(otw: DECISION, ctx: &mut TxContext) {
    // The deployer holds the Cap to create/update the EnclaveConfig (PCRs).
    transfer::public_transfer(enclave::new_cap(otw, ctx), ctx.sender());
    transfer::share_object(DecisionRegistry {
        id: object::new(ctx),
        last_nonce: table::new(ctx),
    });
}

/// Verify the enclave-signed decision, then release the bounded amount through the
/// capability. Returns the `Coin` into the PTB so the caller composes the downstream
/// supply (e.g. into a lending protocol) in the same transaction.
public fun execute_decision<C>(
    registry: &mut DecisionRegistry,
    treasury: &mut Treasury<C>,
    enclave: &Enclave<DECISION>,
    cap: &AgentCap,
    amount: u64,
    nonce: u64,
    timestamp_ms: u64,
    signature: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    let treasury_id = object::id(treasury);
    let payload = DecisionPayload { treasury: treasury_id, amount, nonce };
    let ok = enclave.verify_signature(DECISION_INTENT, timestamp_ms, payload, &signature);
    assert!(ok, EInvalidSignature);

    // One enclave signature = one release: reject replayed/stale nonces.
    consume_nonce(registry, treasury_id, nonce);

    // Capability layer still enforces per-tx / period caps, expiry, and revocation.
    capability::release_for_action(treasury, cap, amount, clock, ctx)
}

/// Reject a replayed or stale nonce, then record it as the latest for the treasury.
/// Nonces are per-treasury and must strictly increase (so the first must be > 0).
fun consume_nonce(registry: &mut DecisionRegistry, treasury: ID, nonce: u64) {
    if (registry.last_nonce.contains(treasury)) {
        let last = registry.last_nonce.borrow_mut(treasury);
        assert!(nonce > *last, EReplayedOrStaleNonce);
        *last = nonce;
    } else {
        assert!(nonce > 0, EReplayedOrStaleNonce);
        registry.last_nonce.add(treasury, nonce);
    }
}

// === Tests ===

#[test_only]
use std::bcs;
#[test_only]
use std::unit_test::assert_eq;

#[test_only]
fun new_registry(ctx: &mut TxContext): DecisionRegistry {
    DecisionRegistry { id: object::new(ctx), last_nonce: table::new(ctx) }
}

#[test_only]
fun destroy_registry(mut reg: DecisionRegistry, treasury: ID) {
    let _nonce = reg.last_nonce.remove(treasury);
    let DecisionRegistry { id, last_nonce } = reg;
    last_nonce.destroy_empty();
    id.delete();
}

/// Pins the wire format the enclave must reproduce: a DecisionPayload is
/// id(32) + amount(8, LE) + nonce(8, LE) = 48 bytes, fields in this order.
#[test]
fun decision_payload_serde() {
    let payload = DecisionPayload {
        treasury: object::id_from_address(@0x1),
        amount: 1000,
        nonce: 7,
    };
    let bytes = bcs::to_bytes(&payload);
    assert_eq!(bytes.length(), 48);
    assert_eq!(
        bytes,
        x"0000000000000000000000000000000000000000000000000000000000000001e8030000000000000700000000000000",
    );
}

/// Round-trips a real secp256k1 signature produced off-chain by
/// agent/scripts/gen-decision-vectors.ts over the identical BCS envelope.
/// Proves TS<->Move BCS parity AND that the enclave signature path verifies.
#[test]
fun verify_real_enclave_signature() {
    let mut ctx = tx_context::dummy();
    let pk = x"034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
    let e = enclave::new_enclave_for_testing<DECISION>(pk, &mut ctx);
    let sig =
        x"f02f7e72ff9eae4a8762df11bff89ff9e1cb2c87f734b3958f650cc031baec532bb1f6e8b62f3a7f185bd9ce5b2f9d0807b90e6b5f62ac8f2eed63d4dd92dea4";

    let payload = DecisionPayload { treasury: object::id_from_address(@0x1), amount: 1000, nonce: 7 };
    assert!(e.verify_signature(DECISION_INTENT, 1_700_000_000_000, payload, &sig));

    // Any tamper (here: amount 1000 -> 1001) breaks verification.
    let tampered = DecisionPayload { treasury: object::id_from_address(@0x1), amount: 1001, nonce: 7 };
    assert!(!e.verify_signature(DECISION_INTENT, 1_700_000_000_000, tampered, &sig));

    e.destroy();
}

#[test]
fun nonce_strictly_increases() {
    let mut ctx = tx_context::dummy();
    let mut reg = new_registry(&mut ctx);
    let t = object::id_from_address(@0x2);
    consume_nonce(&mut reg, t, 1);
    consume_nonce(&mut reg, t, 2);
    consume_nonce(&mut reg, t, 99);
    destroy_registry(reg, t);
}

#[test, expected_failure(abort_code = EReplayedOrStaleNonce)]
fun replayed_nonce_aborts() {
    let mut ctx = tx_context::dummy();
    let mut reg = new_registry(&mut ctx);
    let t = object::id_from_address(@0x2);
    consume_nonce(&mut reg, t, 7);
    consume_nonce(&mut reg, t, 7); // replay of the same nonce — aborts
    abort
}

#[test, expected_failure(abort_code = EReplayedOrStaleNonce)]
fun stale_nonce_aborts() {
    let mut ctx = tx_context::dummy();
    let mut reg = new_registry(&mut ctx);
    let t = object::id_from_address(@0x2);
    consume_nonce(&mut reg, t, 10);
    consume_nonce(&mut reg, t, 9); // lower than last — aborts
    abort
}
