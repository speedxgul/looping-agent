# Deploying the Treasury Enclave to Marlin Oyster (real Nitro attestation)

How to run the treasury signing enclave on a real AWS Nitro enclave (via Marlin Oyster),
get a genuine attestation that binds the enclave's **own** secp256k1 key, register it
on-chain, and drive the attested `verified_supply` flow — with **no dev key**.

> Done live on testnet 2026-06-21. The exact object IDs from that run are in
> [Completed-run reference](#completed-run-reference) at the bottom; reuse the package, or
> re-run the whole thing from scratch with the steps below.

> **⚠️ Split architecture (current):** the enclave deploy + attestation (Steps 0–3) are
> unchanged, but the on-chain registration commands (Steps 4–5) differ — the `enclave` module
> now lives in its own **framework package** and the `DECISION` type in **core**, so they're
> separate `--package` / `--type-args`. `register-enclave.sh` (which assumes one package for
> both) no longer applies; use the inline PTB. See **[`mainnet-deploy.md`](mainnet-deploy.md)
> Step 3** and **[`move/packages/DEPLOY.md`](../../move/packages/DEPLOY.md) Steps E4–E5** for
> the exact split commands. Also: `register_enclave_dev` lives under `move/packages/` now (not
> `move/sources/`), and PCRs are reproducible across re-deploys of the same pinned image.

## How it works (the part that wasn't obvious)

The Marlin Oyster **blue base image (v3.0.0)** does the key work for us:

- It generates a **secp256k1** keypair **inside the enclave** at `/app/ecdsa.sec`.
- It serves **two** attestations: **`:1300`** binds the base's own **ed25519** identity key
  (this is what `oyster-cvm verify` checks); **`:1301`** binds **our secp256k1 public key**.
- Our app (`enclave/app`) just **reads `/app/ecdsa.sec`** and signs with it.

So on-chain `register_enclave` must consume the **`:1301`** document. We do **not** bundle
`keygen` or an attestation-server — the base provides them. `--deployment sui` selects the
Sui billing path; it does **not** do the key binding.

```
 Oyster blue base                      our app (enclave/app)            Sui testnet
 ────────────────                      ─────────────────────            ───────────
 keygen -> /app/ecdsa.sec  ──read──>   sign ActionIntent  ──sig──>  decision::verified_supply_entry
 attest secp256k1 pubkey                serve :3000                       verify against
   -> :1301 attestation  ──register──> enclave::register_enclave ──>   Enclave<DECISION>.pk
```

## Prerequisites

- **Sui CLI** on `testnet`, with the published package (or republish — see note in step 4).
- **`oyster-cvm` CLI** + **Docker 29+** (so `docker load` digests stay stable).
- A **Sui wallet funded with SUI + USDC** — Oyster's `--deployment sui` path bills on Sui,
  not Arbitrum. (~0.1 USDC/hour; a 60-min test run is a few cents.)
- A container registry you can push an **arm64** image to (e.g. Docker Hub).
- `python3` + `bun` (for the register + decode helper scripts).

All paths below are relative to the repo root. Run deploy steps from `enclave/`.

## Step 0 — config

All deployment-specific IDs live in one file, not in the scripts. Copy the template and
fill in what you know; you'll set `ENCLAVE_IP`/`ENCLAVE`/`CONFIG` as you go.

```bash
cp deployments/testnet.env.example deployments/testnet.env   # then edit it
source deployments/testnet.env                                # re-source after edits
```

The scripts ([enclave/scripts/register-enclave.sh](../../enclave/scripts/register-enclave.sh),
[agent/scripts/live-attested-decide.ts](../../agent/scripts/live-attested-decide.ts)) read
these from the environment and error out if any required one is missing — nothing is
hardcoded in them.

---

## Step 1 — Build + push the reproducible arm64 image, pin its digest

```bash
cd enclave
REGISTRY=<your-dockerhub-user>
docker buildx build --platform linux/arm64 -t $REGISTRY/treasury-enclave:repro --push ./app

# Pin the pushed digest into the compose (PCR16 = the image measurement must be reproducible):
DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' $REGISTRY/treasury-enclave:repro)
echo "$DIGEST"   # -> <registry>/treasury-enclave@sha256:...
sed -i '' "s@image: docker.io/.*@image: docker.io/${DIGEST}@" docker-compose.yml
grep image: docker-compose.yml   # confirm it shows a real @sha256:, not a placeholder
```

> Why digest, not `:latest`: the attestation binds PCR16 to the exact image content. A
> moving tag would change the measurement and break registration.

## Step 2 — Deploy to Oyster

```bash
export PRIVATE_KEY="suiprivkey..."        # Sui key funded with SUI + USDC
oyster-cvm deploy \
  --wallet-private-key "$PRIVATE_KEY" \
  --docker-compose ./docker-compose.yml \
  --instance-type c6g.xlarge \
  --duration-in-minutes 60 \
  --deployment sui
# -> note the PUBLIC_IP from the output (and IMAGE_ID / PCR16)
export ENCLAVE_IP=<PUBLIC_IP>   # also record it in deployments/testnet.env
```

Two flags that matter:
- **`--instance-type c6g.xlarge`** — the default host is too small and the in-enclave image
  pull dies with *"no space left on device"*.
- **`--deployment sui`** — bills on Sui (so `--wallet-private-key` is a `suiprivkey...`).

## Step 3 — Verify the enclave + decode the :1301 key (BEFORE spending gas)

```bash
curl -s http://$ENCLAVE_IP:3000/health        # -> ok        (our app booted on :3000)
curl -s http://$ENCLAVE_IP:3000/public-key     # -> {"public_key":"03...","scheme":"secp256k1"}
oyster-cvm verify --enclave-ip $ENCLAVE_IP     # cert chain -> AWS root; prints PCR0/1/2 (uses :1300)

# Decode the :1301 attestation locally — this is the secp256k1-bound one we register:
curl -s http://$ENCLAVE_IP:1301/attestation/hex | bun run scripts/decode-attestation.ts
```

In the decoder output, **`public_key: len=64 … SECP256K1`** is the go signal. Note the four
**PCR0/1/2/16** values it prints — they go into step 4. Sanity check: the compressed form of
that 64-byte key equals `/public-key` (prefix `02`/`03` + the X coordinate); that proves our
app signs with the attested key.

> If the decoder prints `len=32 … ED25519`, you fetched `:1300` (base key) instead of
> `:1301`. Re-check the port.

## Step 4 — Create the EnclaveConfig with the measured PCRs

Needs your `enclave::Cap<DECISION>` (minted to the publisher at publish; find it with
`sui client objects | grep -B5 "enclave::Cap<"`).

```bash
# $PKG comes from deployments/testnet.env (sourced in step 0).
sui client call --package $PKG --module enclave --function create_enclave_config \
  --type-args ${PKG}::decision::DECISION \
  --args <CAP_ID> "treasury-enclave" 0x<PCR0> 0x<PCR1> 0x<PCR2> 0x<PCR16> \
  --gas-budget 100000000
# -> record the created EnclaveConfig<DECISION> as CONFIG in deployments/testnet.env, then re-source
```

> Republishing? `sui move build && sui client publish --with-unpublished-dependencies`. The
> `init` transfers a fresh `Cap<DECISION>` to you and shares the `DecisionRegistry`. Update
> `PKG` everywhere.

## Step 5 — Register the enclave (binds the secp256k1 key on-chain)

Fetches `:1301` and submits `load_nitro_attestation -> register_enclave<DECISION>` in one
shot (Nitro docs are time-bounded; re-run if it ever complains about a stale document):

```bash
# Reads ENCLAVE_IP, CONFIG, PKG from the sourced env.
bash scripts/register-enclave.sh
# -> record the created Enclave<DECISION> as ENCLAVE in deployments/testnet.env (the attested signer)
```

This only succeeds if the cert chain verifies to the AWS Nitro root **and** the attestation
PCRs match `EnclaveConfig`. Abort `EInvalidPCRs` = wrong/stale PCRs in step 4.

## Step 6 — Run the attested flow (enclave decides + signs, chain verifies)

```bash
# All inputs (PKG, ENCLAVE_IP, ENCLAVE, AGENTCAP, ADDR) come from the sourced env.
cd agent && bun scripts/live-attested-decide.ts
```

It auto-discovers the `DecisionRegistry` (from the publish tx) and `Treasury` (from
`AgentCap.treasury`), sends market data to the enclave's single `/decide` endpoint — which
runs the optimizer **in the TEE**, picks the protocol + amount, and signs that
`ActionIntent` — then submits `verified_supply_entry` and runs a tamper test. Expect:

- `verified_supply_entry -> success` + a `FundsReleased` event.
- `[TAMPER] rejected` — same signature, bumped amount, fails the on-chain signature check.

`AMOUNT` must satisfy the treasury's `per_tx_cap` and remaining `period_cap`, and be ≤
`funds`. Inspect them with:
```bash
bun -e "const {SuiClient}=await import('@mysten/sui/client');const c=new SuiClient({url:'https://fullnode.testnet.sui.io:443'});console.log((await c.getObject({id:'<TREASURY>',options:{showContent:true}})).data.content.fields)"
```

## Step 7 — Cleanup

Oyster auto-stops at `--duration-in-minutes`; or stop early per `oyster-cvm` docs. The
on-chain `EnclaveConfig` / `Enclave` objects persist (they're the registration); you only
re-register if you redeploy the enclave (new IP → new attestation, but **same** image →
**same** PCRs → `register_enclave` still binds the same key class).

---

## Gotchas (hard-won)

| Symptom | Cause | Fix |
| --- | --- | --- |
| `register_enclave` aborts `EInvalidPublicKeyLength` | Registered the `:1300` doc (32-byte ed25519) | Register the **`:1301`** doc (64-byte secp256k1) |
| Deploy: *"no space left on device"* | Default host too small for the in-enclave pull | `--instance-type c6g.xlarge` |
| App unreachable / `/public-key` 404 | App on wrong port, or a shell-escaped `;` corrupting the curl path | App serves **:3000**; curl the path with no trailing `; echo` |
| `oyster-cvm verify --pcr-preset` says *pcrs mismatch* | Preset assumes PCR16 = all-zeros; ours is the app measurement | Harmless — read PCRs from the `:1301` decode instead |
| `release_for_action` abort code 0 (`EExceedsPerTxCap`) | `AMOUNT` over the treasury cap | Lower `AMOUNT` (≤ `per_tx_cap`, ≤ remaining `period_cap`) |
| `funds after` looks unchanged | Read-after-write RPC lag | Trust the `FundsReleased` event / `spent_in_period` |

## Productionization

- **Delete `enclave::register_enclave_dev`** from `enclave.move` and republish — it's the
  localnet backdoor (registers a key with no PCR binding) and has no place in production now
  that real attestation works.
- Keep the image build reproducible (frozen lockfile, pinned base) so anyone can rebuild and
  match PCR0/1/2/16 from the attestation.

## Completed-run reference

Testnet, 2026-06-21. Helper scripts: `enclave/scripts/{decode-attestation.ts,register-enclave.sh}`,
`agent/scripts/live-attested-decide.ts`.

| Object | ID |
| --- | --- |
| Package | `0x79517b947e204f8ba6377e9e1ddc26de49145d1f55643875b79e4297b1b4396c` |
| Enclave (Oyster job 191) | IP `13.207.23.212` — app `:3000`, attestation `:1300`/`:1301` |
| Attested signing key (compressed) | `031674d1bb0d6870e5e77554172d6de7f1703f1bcf60a1438bc123c443b267897d` |
| `Cap<DECISION>` | `0xfed11358742e3083ec85a68912b3365bfc3049a4c64bfb4a6125291380cc1710` |
| `EnclaveConfig<DECISION>` | `0x2d278d3fe0eee82ba236be0b6e6c4987d2885610b9ecca6b2a0cd025072f99b8` |
| **`Enclave<DECISION>` (attested signer)** | `0x425a87be07be7a8d9a4efdc58c9a72e0052b528bfabefbcb97754d166c61cef3` |
| `DecisionRegistry` | `0x4db5b390b7ed501c9e3391b8be898ac8162fa2ab94a09862783aed1afd22ff5b` |
| `Treasury<SUI>` | `0x10f9730a5d11292021b9363497ab655125fe2db00b00db24bd86ead5fee4fd80` |
| `AgentCap<SUI>` | `0x6443cc6c98cca5d1eded71e6ada7329582736c39ddd3f2bcf122337bfe978cf7` |

PCRs: PCR0 `3aa0e6e6…20634c` · PCR1 `b0d319fa…147909f8` · PCR2 `fdb2295d…dfe057e` · PCR16
`cdfa8089…282a1ac8`. Live VALID tx: `3aUiam6XbBqVysvoUAQ6Y48fpsdsiY3i5Z2ec7xp9Z1x`.
