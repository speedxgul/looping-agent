/// Attested execution: gate a bounded supply handoff on an action intent signed by
/// the registered TEE enclave. This is the third trust layer, in front of the
/// capability's own bounds (capability.move) -- no single layer is trusted.
///
/// Flow: the enclave (Nitro, registered via `enclave::register_enclave`) signs a
/// canonical `ActionIntent` with its secp256k1 key; on-chain we reconstruct the exact
/// BCS envelope, verify the signature against the registered key, and only then
/// release the bounded amount from the treasury for a protocol-specific PTB builder.
module treasury_agent::decision;

use enclave::enclave::{Self, Enclave};
use sui::clock::Clock;
use sui::coin::Coin;
use sui::event;
use sui::table::{Self, Table};
use treasury_agent::capability::{Self, AgentCap, Treasury};

/// Domain separator so an enclave signature for one app cannot be replayed in another.
const DECISION_INTENT: u8 = 0;
const ACTION_INTENT_SCHEMA_VERSION: u16 = 1;
const ACTION_SUPPLY: u8 = 1;
const PROTOCOL_SUILEND: u8 = 1;
const PROTOCOL_NAVI: u8 = 2;
const PROTOCOL_SCALLOP: u8 = 3;

#[error]
const EInvalidSignature: vector<u8> = b"Decision is not signed by the registered enclave";
#[error]
const EReplayedOrStaleNonce: vector<u8> = b"Decision nonce was already consumed or is stale (replay)";
#[error]
const EIntentTreasuryMismatch: vector<u8> = b"Decision intent targets a different treasury";
#[error]
const EIntentAgentCapMismatch: vector<u8> = b"Decision intent targets a different agent capability";
#[error]
const EIntentExpired: vector<u8> = b"Decision intent has expired";
#[error]
const EInvalidSchemaVersion: vector<u8> = b"Decision intent schema version is not supported";
#[error]
const EInvalidActionKind: vector<u8> = b"Only supply actions are supported in v1";
#[error]
const EInvalidProtocol: vector<u8> = b"Protocol is not supported by the v1 supply adapter";
#[error]
const EInvalidAmount: vector<u8> = b"Supply amount must be greater than zero";

/// One-time witness binding the registered `Enclave<DECISION>` to this app.
public struct DECISION has drop {}

/// What the enclave signs. Field order/types here MUST match the TS/enclave BCS
/// serialization exactly.
public struct ActionIntent has copy, drop {
    schema_version: u16,
    treasury: ID,
    agent_cap: ID,
    nonce: u64,
    expires_at_ms: u64,
    action_kind: u8,
    protocol_id: u8,
    coin_type_hash: vector<u8>,
    amount: u64,
    min_health_factor_bps: u64,
    max_protocol_exposure: u64,
    policy_hash: vector<u8>,
    input_hash: vector<u8>,
    report_hash: vector<u8>,
    intent_hash: vector<u8>,
}

/// Receipt emitted after a verified supply handoff succeeds. This is the on-chain
/// proof that a TEE-signed, policy-bounded intent released funds from the treasury.
public struct SupplyIntentVerified has copy, drop {
    treasury: ID,
    agent_cap: ID,
    protocol_id: u8,
    amount: u64,
    nonce: u64,
    intent_hash: vector<u8>,
    input_hash: vector<u8>,
    report_hash: vector<u8>,
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

public fun action_supply(): u8 { ACTION_SUPPLY }
public fun protocol_suilend(): u8 { PROTOCOL_SUILEND }
public fun protocol_navi(): u8 { PROTOCOL_NAVI }
public fun protocol_scallop(): u8 { PROTOCOL_SCALLOP }

/// Verify the enclave-signed supply intent, then release the bounded amount through
/// the capability. Returns the `Coin` into the PTB so a protocol-specific builder can
/// compose the downstream supply in the same transaction.
///
/// This function is a verified handoff boundary, not yet a direct protocol adapter.
/// Production protocol templates should consume the returned coin immediately and
/// emit their own protocol receipt once the exact protocol Move call surfaces are
/// wired.
public fun execute_verified_supply_handoff<C>(
    registry: &mut DecisionRegistry,
    treasury: &mut Treasury<C>,
    enclave: &Enclave<DECISION>,
    cap: &AgentCap,
    intent: ActionIntent,
    timestamp_ms: u64,
    signature: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    let treasury_id = object::id(treasury);
    let ok = enclave.verify_signature(DECISION_INTENT, timestamp_ms, intent, &signature);
    assert!(ok, EInvalidSignature);

    assert!(intent.schema_version == ACTION_INTENT_SCHEMA_VERSION, EInvalidSchemaVersion);
    assert!(intent.treasury == treasury_id, EIntentTreasuryMismatch);
    assert!(intent.agent_cap == object::id(cap), EIntentAgentCapMismatch);
    assert!(clock.timestamp_ms() <= intent.expires_at_ms, EIntentExpired);
    assert!(intent.action_kind == ACTION_SUPPLY, EInvalidActionKind);
    assert!(is_supported_protocol(intent.protocol_id), EInvalidProtocol);
    assert!(intent.amount > 0, EInvalidAmount);

    // One enclave signature = one release: reject replayed/stale nonces.
    consume_nonce(registry, treasury_id, intent.nonce);

    // Capability layer still enforces per-tx / period caps, expiry, and revocation.
    let coin = capability::release_for_action(treasury, cap, intent.amount, clock, ctx);

    event::emit(SupplyIntentVerified {
        treasury: treasury_id,
        agent_cap: intent.agent_cap,
        protocol_id: intent.protocol_id,
        amount: intent.amount,
        nonce: intent.nonce,
        intent_hash: intent.intent_hash,
        input_hash: intent.input_hash,
        report_hash: intent.report_hash,
    });

    coin
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

fun is_supported_protocol(protocol_id: u8): bool {
    protocol_id == PROTOCOL_SUILEND || protocol_id == PROTOCOL_NAVI || protocol_id == PROTOCOL_SCALLOP
}

// === Tests ===

#[test_only]
use std::bcs;
#[test_only]
use sui::coin::mint_for_testing;
#[test_only]
use sui::sui::SUI;
#[test_only]
use std::unit_test::assert_eq;

#[test_only]
fun new_registry(ctx: &mut TxContext): DecisionRegistry {
    DecisionRegistry { id: object::new(ctx), last_nonce: table::new(ctx) }
}

#[test_only]
fun destroy_registry(reg: DecisionRegistry) {
    let DecisionRegistry { id, last_nonce } = reg;
    table::drop(last_nonce);
    id.delete();
}

#[test_only]
fun digest(byte: u8): vector<u8> {
    vector[
        byte, byte, byte, byte, byte, byte, byte, byte,
        byte, byte, byte, byte, byte, byte, byte, byte,
        byte, byte, byte, byte, byte, byte, byte, byte,
        byte, byte, byte, byte, byte, byte, byte, byte,
    ]
}

#[test_only]
fun test_intent(treasury: ID, agent_cap: ID, amount: u64, nonce: u64): ActionIntent {
    ActionIntent {
        schema_version: 1,
        treasury,
        agent_cap,
        nonce,
        expires_at_ms: 1_800_000_000_000,
        action_kind: ACTION_SUPPLY,
        protocol_id: PROTOCOL_NAVI,
        coin_type_hash: digest(0x11),
        amount,
        min_health_factor_bps: 12_500,
        max_protocol_exposure: 100_000,
        policy_hash: digest(0x22),
        input_hash: digest(0x33),
        report_hash: digest(0x44),
        intent_hash: digest(0x55),
    }
}

/// Pins the wire format the enclave must reproduce. Any field order/type change
/// must update the TS vector generator and this test together.
#[test]
fun action_intent_serde() {
    let payload = test_intent(object::id_from_address(@0x1), object::id_from_address(@0x2), 1000, 7);
    let bytes = bcs::to_bytes(&payload);
    assert_eq!(bytes.length(), 273);
    assert_eq!(
        bytes,
        x"010000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002070000000000000000505c18a30100000102201111111111111111111111111111111111111111111111111111111111111111e803000000000000d430000000000000a086010000000000202222222222222222222222222222222222222222222222222222222222222222203333333333333333333333333333333333333333333333333333333333333333204444444444444444444444444444444444444444444444444444444444444444205555555555555555555555555555555555555555555555555555555555555555",
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
        x"34c0d244c8961abb99440aab9b006dc2010310a8b8f3736a5959331602280430570b2eaa49b01a51ded426426f00d8946bec7b569e3349dfdc8f470fce34423f";

    let payload = test_intent(object::id_from_address(@0x1), object::id_from_address(@0x2), 1000, 7);
    assert!(e.verify_signature(DECISION_INTENT, 1_700_000_000_000, payload, &sig));

    // Any tamper (here: amount 1000 -> 1001) breaks verification.
    let tampered = test_intent(object::id_from_address(@0x1), object::id_from_address(@0x2), 1001, 7);
    assert!(!e.verify_signature(DECISION_INTENT, 1_700_000_000_000, tampered, &sig));

    e.destroy();
}

#[test, expected_failure(abort_code = EInvalidSignature)]
fun supply_handoff_rejects_invalid_signature() {
    let mut ctx = tx_context::dummy();
    let clock = sui::clock::create_for_testing(&mut ctx);
    let funds = mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut treasury, _owner_cap, agent_cap) =
        capability::new<SUI>(funds, 100, 300, 86_400_000, 1_800_000_000_000, &clock, &mut ctx);
    let mut reg = new_registry(&mut ctx);

    let pk = x"034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
    let e = enclave::new_enclave_for_testing<DECISION>(pk, &mut ctx);
    let bad_sig =
        x"00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

    let intent = test_intent(object::id(&treasury), object::id(&agent_cap), 100, 7);
    let _released = execute_verified_supply_handoff(
        &mut reg,
        &mut treasury,
        &e,
        &agent_cap,
        intent,
        1_700_000_000_000,
        bad_sig,
        &clock,
        &mut ctx,
    );
    abort
}

#[test]
fun nonce_strictly_increases() {
    let mut ctx = tx_context::dummy();
    let mut reg = new_registry(&mut ctx);
    let t = object::id_from_address(@0x2);
    consume_nonce(&mut reg, t, 1);
    consume_nonce(&mut reg, t, 2);
    consume_nonce(&mut reg, t, 99);
    destroy_registry(reg);
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
