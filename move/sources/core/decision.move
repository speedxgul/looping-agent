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
use treasury_agent::mock_supply;
use treasury_agent::suilend_adapter;
use suilend::lending_market::LendingMarket;
use treasury_agent::scallop_adapter;
use protocol::market::Market;
use protocol::version::Version;
use treasury_agent::navi_adapter;
use lending_core::storage::Storage;
use lending_core::pool::Pool;
use lending_core::incentive_v2::Incentive as IncentiveV2;
use lending_core::incentive_v3::Incentive as IncentiveV3;

/// Domain separator so an enclave signature for one app can't be replayed in another.
const DECISION_INTENT: u8 = 0;
/// v1 action_kind: supply.
const ACTION_SUPPLY: u8 = 0;
/// Placeholder protocol id (matches mock_supply::PROTOCOL_MOCK).
const PROTOCOL_MOCK: u8 = 255;
/// Suilend protocol id (matches suilend_adapter's Suilend protocol id).
const PROTOCOL_SUILEND: u8 = 0;
/// Scallop protocol id (matches scallop_adapter's Scallop protocol id).
const PROTOCOL_SCALLOP: u8 = 1;
/// NAVI protocol id (matches navi_adapter's NAVI protocol id).
const PROTOCOL_NAVI: u8 = 2;

#[error]
const EInvalidSignature: vector<u8> = b"Decision is not signed by the registered enclave";
#[error]
const EReplayedOrStaleNonce: vector<u8> = b"Decision nonce was already consumed or is stale (replay)";
#[error]
const EWrongTreasuryIntent: vector<u8> = b"ActionIntent does not target this treasury";
#[error]
const EWrongAgentCap: vector<u8> = b"ActionIntent does not authorize this AgentCap";
#[error]
const EIntentExpired: vector<u8> = b"ActionIntent has expired";
#[error]
const EUnsupportedAction: vector<u8> = b"Unsupported action_kind";
#[error]
const EUnsupportedProtocol: vector<u8> = b"Unsupported protocol_id";

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

/// The full product action schema (design §10). Field order MUST match the BCS in
/// agent/scripts/gen-action-intent-vector.ts and enclave/app/action_intent.ts.
public struct ActionIntent has copy, drop {
    schema_version: u16,
    chain_id: vector<u8>,
    treasury_id: ID,
    agent_cap_id: ID,
    nonce: u64,
    expires_at_ms: u64,
    action_kind: u8,
    protocol_id: u8,
    asset_type: vector<u8>,
    amount: u64,
    min_health_factor_bps: u64,
    max_protocol_exposure: u64,
    policy_hash: vector<u8>,
    input_hash: vector<u8>,
    rationale_hash: vector<u8>,
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
    cap: &AgentCap<C>,
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

/// Verify the enclave-signed ActionIntent, then execute it. The ONLY external entry
/// to fund movement on the attested path — `execute_verified` is package-internal,
/// so a PTB cannot skip the signature check. ActionIntent is `copy`, so it is passed
/// to both the verifier and the executor.
public fun verified_supply<C>(
    registry: &mut DecisionRegistry,
    treasury: &mut Treasury<C>,
    enclave: &Enclave<DECISION>,
    cap: &AgentCap<C>,
    intent: ActionIntent,
    timestamp_ms: u64,
    signature: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(
        enclave.verify_signature(DECISION_INTENT, timestamp_ms, intent, &signature),
        EInvalidSignature,
    );
    execute_verified(registry, treasury, cap, intent, clock, ctx);
}

/// Suilend variant of `verified_supply`: verify the enclave signature, then execute
/// against the REAL Suilend adapter. Carries the extra `LendingMarket<P>` +
/// `reserve_array_index` the protocol call needs — these are NOT part of the signed
/// intent (the off-chain Submitter supplies them; the intent's `protocol_id` is what
/// binds the decision to Suilend).
public fun verified_supply_suilend<P, C>(
    registry: &mut DecisionRegistry,
    treasury: &mut Treasury<C>,
    enclave: &Enclave<DECISION>,
    cap: &AgentCap<C>,
    lending_market: &mut LendingMarket<P>,
    reserve_array_index: u64,
    intent: ActionIntent,
    timestamp_ms: u64,
    signature: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(
        enclave.verify_signature(DECISION_INTENT, timestamp_ms, intent, &signature),
        EInvalidSignature,
    );
    execute_verified_suilend<P, C>(
        registry, treasury, cap, lending_market, reserve_array_index, intent, clock, ctx,
    );
}

/// Scallop variant of `verified_supply`: verify the enclave signature, then execute
/// against the real Scallop adapter. Adds Scallop's shared `Version` + `Market` args.
public fun verified_supply_scallop<C>(
    registry: &mut DecisionRegistry,
    treasury: &mut Treasury<C>,
    enclave: &Enclave<DECISION>,
    cap: &AgentCap<C>,
    version: &Version,
    market: &mut Market,
    intent: ActionIntent,
    timestamp_ms: u64,
    signature: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(
        enclave.verify_signature(DECISION_INTENT, timestamp_ms, intent, &signature),
        EInvalidSignature,
    );
    execute_verified_scallop<C>(registry, treasury, cap, version, market, intent, clock, ctx);
}

/// NAVI variant of `verified_supply`: verify the enclave signature, then execute against
/// the real NAVI adapter. Adds NAVI's shared `Storage` / `Pool<C>` / `Incentive` (v2+v3)
/// objects + the asset index.
public fun verified_supply_navi<C>(
    registry: &mut DecisionRegistry,
    treasury: &mut Treasury<C>,
    enclave: &Enclave<DECISION>,
    cap: &AgentCap<C>,
    storage: &mut Storage,
    pool: &mut Pool<C>,
    incentive_v2: &mut IncentiveV2,
    incentive_v3: &mut IncentiveV3,
    asset: u8,
    intent: ActionIntent,
    timestamp_ms: u64,
    signature: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(
        enclave.verify_signature(DECISION_INTENT, timestamp_ms, intent, &signature),
        EInvalidSignature,
    );
    execute_verified_navi<C>(
        registry, treasury, cap, storage, pool, incentive_v2, incentive_v3, asset, intent, clock, ctx,
    );
}

/// Shared intent checks (binding + expiry + action), protocol-agnostic. Each executor
/// adds its own `protocol_id` assertion and routes to the matching adapter.
fun assert_intent_valid<C>(
    intent: &ActionIntent,
    treasury: &Treasury<C>,
    cap: &AgentCap<C>,
    clock: &Clock,
) {
    assert!(intent.treasury_id == object::id(treasury), EWrongTreasuryIntent);
    assert!(intent.agent_cap_id == object::id(cap), EWrongAgentCap);
    assert!(intent.expires_at_ms >= clock.timestamp_ms(), EIntentExpired);
    assert!(intent.action_kind == ACTION_SUPPLY, EUnsupportedAction);
}

/// Intent-binding + expiry + replay + bounded release + custody (MOCK adapter).
/// Package-internal: reachable only via `verified_supply` (after a verified signature)
/// or from tests.
public(package) fun execute_verified<C>(
    registry: &mut DecisionRegistry,
    treasury: &mut Treasury<C>,
    cap: &AgentCap<C>,
    intent: ActionIntent,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_intent_valid(&intent, treasury, cap, clock);
    assert!(intent.protocol_id == PROTOCOL_MOCK, EUnsupportedProtocol);

    consume_nonce(registry, intent.treasury_id, intent.nonce);

    mock_supply::supply_and_custody(treasury, cap, intent.amount, clock, ctx);
}

/// Same verified pipeline, routing to the REAL Suilend adapter. Package-internal:
/// reachable only via `verified_supply_suilend` (after a verified signature).
public(package) fun execute_verified_suilend<P, C>(
    registry: &mut DecisionRegistry,
    treasury: &mut Treasury<C>,
    cap: &AgentCap<C>,
    lending_market: &mut LendingMarket<P>,
    reserve_array_index: u64,
    intent: ActionIntent,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_intent_valid(&intent, treasury, cap, clock);
    assert!(intent.protocol_id == PROTOCOL_SUILEND, EUnsupportedProtocol);

    consume_nonce(registry, intent.treasury_id, intent.nonce);

    suilend_adapter::supply_and_custody<P, C>(
        treasury,
        cap,
        lending_market,
        reserve_array_index,
        intent.amount,
        clock,
        ctx,
    );
}

/// Same verified pipeline, routing to the REAL Scallop adapter. Carries Scallop's shared
/// `Version` + `Market` objects (not part of the signed intent). Package-internal.
public(package) fun execute_verified_scallop<C>(
    registry: &mut DecisionRegistry,
    treasury: &mut Treasury<C>,
    cap: &AgentCap<C>,
    version: &Version,
    market: &mut Market,
    intent: ActionIntent,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_intent_valid(&intent, treasury, cap, clock);
    assert!(intent.protocol_id == PROTOCOL_SCALLOP, EUnsupportedProtocol);

    consume_nonce(registry, intent.treasury_id, intent.nonce);

    scallop_adapter::supply_and_custody<C>(
        treasury,
        cap,
        version,
        market,
        intent.amount,
        clock,
        ctx,
    );
}

/// Same verified pipeline, routing to the REAL NAVI adapter (AccountCap custody). Carries
/// NAVI's shared `Storage` / `Pool<C>` / `Incentive` (v2+v3) objects + the asset index —
/// not part of the signed intent. Package-internal.
public(package) fun execute_verified_navi<C>(
    registry: &mut DecisionRegistry,
    treasury: &mut Treasury<C>,
    cap: &AgentCap<C>,
    storage: &mut Storage,
    pool: &mut Pool<C>,
    incentive_v2: &mut IncentiveV2,
    incentive_v3: &mut IncentiveV3,
    asset: u8,
    intent: ActionIntent,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_intent_valid(&intent, treasury, cap, clock);
    assert!(intent.protocol_id == PROTOCOL_NAVI, EUnsupportedProtocol);

    consume_nonce(registry, intent.treasury_id, intent.nonce);

    navi_adapter::supply_and_custody<C>(
        treasury,
        cap,
        storage,
        pool,
        incentive_v2,
        incentive_v3,
        asset,
        intent.amount,
        clock,
        ctx,
    );
}

/// Reconstruct the signed ActionIntent from pure fields (so it can be passed in a PTB).
fun build_intent(
    schema_version: u16,
    chain_id: vector<u8>,
    treasury_id: address,
    agent_cap_id: address,
    nonce: u64,
    expires_at_ms: u64,
    action_kind: u8,
    protocol_id: u8,
    asset_type: vector<u8>,
    amount: u64,
    min_health_factor_bps: u64,
    max_protocol_exposure: u64,
    policy_hash: vector<u8>,
    input_hash: vector<u8>,
    rationale_hash: vector<u8>,
): ActionIntent {
    ActionIntent {
        schema_version,
        chain_id,
        treasury_id: object::id_from_address(treasury_id),
        agent_cap_id: object::id_from_address(agent_cap_id),
        nonce,
        expires_at_ms,
        action_kind,
        protocol_id,
        asset_type,
        amount,
        min_health_factor_bps,
        max_protocol_exposure,
        policy_hash,
        input_hash,
        rationale_hash,
    }
}

/// PTB-callable entry: rebuild the ActionIntent from pure fields, then run the
/// signature-gated verified supply. This is the function the off-chain Submitter calls.
public fun verified_supply_entry<C>(
    registry: &mut DecisionRegistry,
    treasury: &mut Treasury<C>,
    enclave: &Enclave<DECISION>,
    cap: &AgentCap<C>,
    schema_version: u16,
    chain_id: vector<u8>,
    treasury_id: address,
    agent_cap_id: address,
    nonce: u64,
    expires_at_ms: u64,
    action_kind: u8,
    protocol_id: u8,
    asset_type: vector<u8>,
    amount: u64,
    min_health_factor_bps: u64,
    max_protocol_exposure: u64,
    policy_hash: vector<u8>,
    input_hash: vector<u8>,
    rationale_hash: vector<u8>,
    timestamp_ms: u64,
    signature: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let intent = build_intent(
        schema_version, chain_id, treasury_id, agent_cap_id, nonce, expires_at_ms,
        action_kind, protocol_id, asset_type, amount, min_health_factor_bps,
        max_protocol_exposure, policy_hash, input_hash, rationale_hash,
    );
    verified_supply(registry, treasury, enclave, cap, intent, timestamp_ms, signature, clock, ctx);
}

/// PTB-callable Suilend entry: rebuild the ActionIntent from pure fields, then run the
/// signature-gated Suilend supply. Same as `verified_supply_entry` plus the
/// `LendingMarket<P>` + `reserve_array_index` the Suilend call needs. Type args:
/// `<P (Suilend market type), C (coin)>`.
public fun verified_supply_suilend_entry<P, C>(
    registry: &mut DecisionRegistry,
    treasury: &mut Treasury<C>,
    enclave: &Enclave<DECISION>,
    cap: &AgentCap<C>,
    lending_market: &mut LendingMarket<P>,
    reserve_array_index: u64,
    schema_version: u16,
    chain_id: vector<u8>,
    treasury_id: address,
    agent_cap_id: address,
    nonce: u64,
    expires_at_ms: u64,
    action_kind: u8,
    protocol_id: u8,
    asset_type: vector<u8>,
    amount: u64,
    min_health_factor_bps: u64,
    max_protocol_exposure: u64,
    policy_hash: vector<u8>,
    input_hash: vector<u8>,
    rationale_hash: vector<u8>,
    timestamp_ms: u64,
    signature: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let intent = build_intent(
        schema_version, chain_id, treasury_id, agent_cap_id, nonce, expires_at_ms,
        action_kind, protocol_id, asset_type, amount, min_health_factor_bps,
        max_protocol_exposure, policy_hash, input_hash, rationale_hash,
    );
    verified_supply_suilend<P, C>(
        registry, treasury, enclave, cap, lending_market, reserve_array_index,
        intent, timestamp_ms, signature, clock, ctx,
    );
}

/// PTB-callable Scallop entry: rebuild the ActionIntent, then run the signature-gated
/// Scallop supply. Same as `verified_supply_entry` plus Scallop's shared `Version` +
/// `Market` objects. Type arg: `<C (coin)>`.
public fun verified_supply_scallop_entry<C>(
    registry: &mut DecisionRegistry,
    treasury: &mut Treasury<C>,
    enclave: &Enclave<DECISION>,
    cap: &AgentCap<C>,
    version: &Version,
    market: &mut Market,
    schema_version: u16,
    chain_id: vector<u8>,
    treasury_id: address,
    agent_cap_id: address,
    nonce: u64,
    expires_at_ms: u64,
    action_kind: u8,
    protocol_id: u8,
    asset_type: vector<u8>,
    amount: u64,
    min_health_factor_bps: u64,
    max_protocol_exposure: u64,
    policy_hash: vector<u8>,
    input_hash: vector<u8>,
    rationale_hash: vector<u8>,
    timestamp_ms: u64,
    signature: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let intent = build_intent(
        schema_version, chain_id, treasury_id, agent_cap_id, nonce, expires_at_ms,
        action_kind, protocol_id, asset_type, amount, min_health_factor_bps,
        max_protocol_exposure, policy_hash, input_hash, rationale_hash,
    );
    verified_supply_scallop<C>(
        registry, treasury, enclave, cap, version, market,
        intent, timestamp_ms, signature, clock, ctx,
    );
}

/// PTB-callable NAVI entry: rebuild the ActionIntent, then run the signature-gated NAVI
/// supply. Same as `verified_supply_entry` plus NAVI's shared `Storage` / `Pool<C>` /
/// `Incentive` (v2+v3) objects + the asset index. Type arg: `<C (coin)>`.
public fun verified_supply_navi_entry<C>(
    registry: &mut DecisionRegistry,
    treasury: &mut Treasury<C>,
    enclave: &Enclave<DECISION>,
    cap: &AgentCap<C>,
    storage: &mut Storage,
    pool: &mut Pool<C>,
    incentive_v2: &mut IncentiveV2,
    incentive_v3: &mut IncentiveV3,
    asset: u8,
    schema_version: u16,
    chain_id: vector<u8>,
    treasury_id: address,
    agent_cap_id: address,
    nonce: u64,
    expires_at_ms: u64,
    action_kind: u8,
    protocol_id: u8,
    asset_type: vector<u8>,
    amount: u64,
    min_health_factor_bps: u64,
    max_protocol_exposure: u64,
    policy_hash: vector<u8>,
    input_hash: vector<u8>,
    rationale_hash: vector<u8>,
    timestamp_ms: u64,
    signature: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let intent = build_intent(
        schema_version, chain_id, treasury_id, agent_cap_id, nonce, expires_at_ms,
        action_kind, protocol_id, asset_type, amount, min_health_factor_bps,
        max_protocol_exposure, policy_hash, input_hash, rationale_hash,
    );
    verified_supply_navi<C>(
        registry, treasury, enclave, cap, storage, pool, incentive_v2, incentive_v3, asset,
        intent, timestamp_ms, signature, clock, ctx,
    );
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
use std::unit_test::{assert_eq, destroy};
#[test_only]
use sui::coin::mint_for_testing;
#[test_only]
use sui::sui::SUI;
#[test_only]
const DAY_MS: u64 = 86_400_000;

#[test_only]
fun new_registry(ctx: &mut TxContext): DecisionRegistry {
    DecisionRegistry { id: object::new(ctx), last_nonce: table::new(ctx) }
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
    destroy(reg);
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

#[test]
fun action_intent_serde() {
    let intent = ActionIntent {
        schema_version: 1,
        chain_id: x"04",
        treasury_id: object::id_from_address(@0x1),
        agent_cap_id: object::id_from_address(@0x2),
        nonce: 7,
        expires_at_ms: 1_700_000_100_000,
        action_kind: 0,
        protocol_id: 0,
        asset_type: b"USDC",
        amount: 1000,
        min_health_factor_bps: 0,
        max_protocol_exposure: 0,
        policy_hash: x"1111111111111111111111111111111111111111111111111111111111111111",
        input_hash: x"2222222222222222222222222222222222222222222222222222222222222222",
        rationale_hash: x"3333333333333333333333333333333333333333333333333333333333333333",
    };
    let bytes = bcs::to_bytes(&intent);
    assert_eq!(bytes, x"01000104000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020700000000000000a0eee6cf8b01000000000455534443e80300000000000000000000000000000000000000000000201111111111111111111111111111111111111111111111111111111111111111202222222222222222222222222222222222222222222222222222222222222222203333333333333333333333333333333333333333333333333333333333333333");
}

/// Verifies a real secp256k1 signature over the canonical ActionIntent envelope.
#[test]
fun verify_real_action_intent() {
    let mut ctx = tx_context::dummy();
    let pk = x"034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
    let e = enclave::new_enclave_for_testing<DECISION>(pk, &mut ctx);
    let sig = x"3eff101a6e656813555c38d1ba4a48ddc29bc356abfcc21b2548eb5a4a7b702d2cc6d9f86bdc40d417872662f6c19ba9b5fa52e0148984026278d8d74383fe89";

    let intent = ActionIntent {
        schema_version: 1, chain_id: x"04",
        treasury_id: object::id_from_address(@0x1),
        agent_cap_id: object::id_from_address(@0x2),
        nonce: 7, expires_at_ms: 1_700_000_100_000,
        action_kind: 0, protocol_id: 0, asset_type: b"USDC", amount: 1000,
        min_health_factor_bps: 0, max_protocol_exposure: 0,
        policy_hash: x"1111111111111111111111111111111111111111111111111111111111111111",
        input_hash: x"2222222222222222222222222222222222222222222222222222222222222222",
        rationale_hash: x"3333333333333333333333333333333333333333333333333333333333333333",
    };
    assert!(e.verify_signature(DECISION_INTENT, 1_700_000_000_000, intent, &sig));

    let mut tampered = intent;
    tampered.amount = 1001;
    assert!(!e.verify_signature(DECISION_INTENT, 1_700_000_000_000, tampered, &sig));

    e.destroy();
}

#[test]
fun verified_supply_supplies_and_custodies() {
    let mut ctx = tx_context::dummy();
    let clock = sui::clock::create_for_testing(&mut ctx);
    let mut registry = new_registry(&mut ctx);
    let funds = mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut treasury, owner_cap, agent_cap) =
        capability::new<SUI>(funds, 100, 300, DAY_MS, DAY_MS, &clock, &mut ctx);

    let intent = ActionIntent {
        schema_version: 1, chain_id: x"04",
        treasury_id: object::id(&treasury),
        agent_cap_id: object::id(&agent_cap),
        nonce: 1, expires_at_ms: DAY_MS,
        action_kind: 0, protocol_id: 255, asset_type: b"USDC", amount: 100,
        min_health_factor_bps: 0, max_protocol_exposure: 0,
        policy_hash: x"", input_hash: x"", rationale_hash: x"",
    };
    execute_verified(&mut registry, &mut treasury, &agent_cap, intent, &clock, &mut ctx);

    assert_eq!(treasury.balance(), 900);
    assert!(capability::has_position(&treasury, 255));

    destroy(registry);
    destroy(treasury);
    destroy(owner_cap);
    destroy(agent_cap);
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = EWrongTreasuryIntent)]
fun execute_verified_wrong_treasury_aborts() {
    let mut ctx = tx_context::dummy();
    let clock = sui::clock::create_for_testing(&mut ctx);
    let mut registry = new_registry(&mut ctx);
    let funds = mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut treasury, _owner_cap, agent_cap) =
        capability::new<SUI>(funds, 100, 300, DAY_MS, DAY_MS, &clock, &mut ctx);

    let intent = ActionIntent {
        schema_version: 1, chain_id: x"04",
        treasury_id: object::id_from_address(@0x9),
        agent_cap_id: object::id(&agent_cap),
        nonce: 1, expires_at_ms: DAY_MS,
        action_kind: 0, protocol_id: 255, asset_type: b"USDC", amount: 100,
        min_health_factor_bps: 0, max_protocol_exposure: 0,
        policy_hash: x"", input_hash: x"", rationale_hash: x"",
    };
    execute_verified(&mut registry, &mut treasury, &agent_cap, intent, &clock, &mut ctx);
    abort
}

#[test, expected_failure(abort_code = EWrongAgentCap)]
fun execute_verified_wrong_cap_aborts() {
    let mut ctx = tx_context::dummy();
    let clock = sui::clock::create_for_testing(&mut ctx);
    let mut registry = new_registry(&mut ctx);
    let funds = mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut treasury, _owner_cap, agent_cap) =
        capability::new<SUI>(funds, 100, 300, DAY_MS, DAY_MS, &clock, &mut ctx);

    let intent = ActionIntent {
        schema_version: 1, chain_id: x"04",
        treasury_id: object::id(&treasury),
        agent_cap_id: object::id_from_address(@0x9),
        nonce: 1, expires_at_ms: DAY_MS,
        action_kind: 0, protocol_id: 255, asset_type: b"USDC", amount: 100,
        min_health_factor_bps: 0, max_protocol_exposure: 0,
        policy_hash: x"", input_hash: x"", rationale_hash: x"",
    };
    execute_verified(&mut registry, &mut treasury, &agent_cap, intent, &clock, &mut ctx);
    abort
}

#[test, expected_failure(abort_code = EUnsupportedProtocol)]
fun execute_verified_unsupported_protocol_aborts() {
    let mut ctx = tx_context::dummy();
    let clock = sui::clock::create_for_testing(&mut ctx);
    let mut registry = new_registry(&mut ctx);
    let funds = mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut treasury, _owner_cap, agent_cap) =
        capability::new<SUI>(funds, 100, 300, DAY_MS, DAY_MS, &clock, &mut ctx);

    let intent = ActionIntent {
        schema_version: 1, chain_id: x"04",
        treasury_id: object::id(&treasury),
        agent_cap_id: object::id(&agent_cap),
        nonce: 1, expires_at_ms: DAY_MS,
        action_kind: 0, protocol_id: 7,
        asset_type: b"USDC", amount: 100,
        min_health_factor_bps: 0, max_protocol_exposure: 0,
        policy_hash: x"", input_hash: x"", rationale_hash: x"",
    };
    execute_verified(&mut registry, &mut treasury, &agent_cap, intent, &clock, &mut ctx);
    abort
}

#[test, expected_failure(abort_code = EUnsupportedAction)]
fun execute_verified_unsupported_action_aborts() {
    let mut ctx = tx_context::dummy();
    let clock = sui::clock::create_for_testing(&mut ctx);
    let mut registry = new_registry(&mut ctx);
    let funds = mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut treasury, _owner_cap, agent_cap) =
        capability::new<SUI>(funds, 100, 300, DAY_MS, DAY_MS, &clock, &mut ctx);

    let intent = ActionIntent {
        schema_version: 1, chain_id: x"04",
        treasury_id: object::id(&treasury),
        agent_cap_id: object::id(&agent_cap),
        nonce: 1, expires_at_ms: DAY_MS,
        action_kind: 9,
        protocol_id: 255, asset_type: b"USDC", amount: 100,
        min_health_factor_bps: 0, max_protocol_exposure: 0,
        policy_hash: x"", input_hash: x"", rationale_hash: x"",
    };
    execute_verified(&mut registry, &mut treasury, &agent_cap, intent, &clock, &mut ctx);
    abort
}

#[test, expected_failure(abort_code = EIntentExpired)]
fun execute_verified_expired_aborts() {
    let mut ctx = tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.increment_for_testing(1_000_000);
    let mut registry = new_registry(&mut ctx);
    let funds = mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut treasury, _owner_cap, agent_cap) =
        capability::new<SUI>(funds, 100, 300, DAY_MS, DAY_MS, &clock, &mut ctx);

    let intent = ActionIntent {
        schema_version: 1, chain_id: x"04",
        treasury_id: object::id(&treasury),
        agent_cap_id: object::id(&agent_cap),
        nonce: 1, expires_at_ms: 1,
        action_kind: 0, protocol_id: 255, asset_type: b"USDC", amount: 100,
        min_health_factor_bps: 0, max_protocol_exposure: 0,
        policy_hash: x"", input_hash: x"", rationale_hash: x"",
    };
    execute_verified(&mut registry, &mut treasury, &agent_cap, intent, &clock, &mut ctx);
    abort
}

#[test]
fun entry_build_intent_matches_canonical() {
    let intent = build_intent(
        1, x"04", @0x1, @0x2, 7, 1_700_000_100_000, 0, 0, b"USDC", 1000, 0, 0,
        x"1111111111111111111111111111111111111111111111111111111111111111",
        x"2222222222222222222222222222222222222222222222222222222222222222",
        x"3333333333333333333333333333333333333333333333333333333333333333",
    );
    assert_eq!(
        bcs::to_bytes(&intent),
        x"01000104000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020700000000000000a0eee6cf8b01000000000455534443e80300000000000000000000000000000000000000000000201111111111111111111111111111111111111111111111111111111111111111202222222222222222222222222222222222222222222222222222222222222222203333333333333333333333333333333333333333333333333333333333333333",
    );
}

#[test, expected_failure(abort_code = EReplayedOrStaleNonce)]
fun execute_verified_replayed_nonce_aborts() {
    let mut ctx = tx_context::dummy();
    let clock = sui::clock::create_for_testing(&mut ctx);
    let mut registry = new_registry(&mut ctx);
    let funds = mint_for_testing<SUI>(1_000, &mut ctx);
    let (mut treasury, _owner_cap, agent_cap) =
        capability::new<SUI>(funds, 100, 1_000, DAY_MS, DAY_MS, &clock, &mut ctx);

    let intent = ActionIntent {
        schema_version: 1, chain_id: x"04",
        treasury_id: object::id(&treasury),
        agent_cap_id: object::id(&agent_cap),
        nonce: 5, expires_at_ms: DAY_MS,
        action_kind: 0, protocol_id: 255, asset_type: b"USDC", amount: 100,
        min_health_factor_bps: 0, max_protocol_exposure: 0,
        policy_hash: x"", input_hash: x"", rationale_hash: x"",
    };
    execute_verified(&mut registry, &mut treasury, &agent_cap, intent, &clock, &mut ctx);
    execute_verified(&mut registry, &mut treasury, &agent_cap, intent, &clock, &mut ctx);
    abort
}
