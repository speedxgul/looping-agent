# enclave/ — TEE attestation spike (Marlin Oyster)

Goal of this folder: **walk the TEE pipeline end-to-end** — dockerize → host in a real
Nitro enclave on Marlin Oyster → fetch a real attestation → verify it. No strategy logic
yet; the attestation is about the *enclave image*, not the app, so the app can be anything.

> Oyster's default ("blue") enclave image serves the attestation automatically on
> **port 1300** — you don't write attestation code.

## Prerequisites

- `oyster-cvm` CLI (macOS ARM64):
  ```bash
  sudo wget https://artifacts.marlin.org/oyster/binaries/oyster-cvm_latest_darwin_arm64 \
    -O /usr/local/bin/oyster-cvm && sudo chmod +x /usr/local/bin/oyster-cvm
  ```
- A wallet funded on **Arbitrum One**: **1 USDC + 0.001 ETH** (Oyster bills per minute).
- Docker (only for Phase B — building your own image).

## Phase A — zero-code proof (start here)

Uses Marlin's prebuilt echo server in [`docker-compose.yml`](docker-compose.yml). No build, no push.

```bash
cd enclave

# 1. Deploy for 15 minutes (returns ENCLAVE_IP and IMAGE_ID)
oyster-cvm deploy \
  --wallet-private-key <KEY> \
  --duration-in-minutes 15 \
  --docker-compose docker-compose.yml
# (add `--arch amd64` if your image is amd64)

# 2. Verify the attestation (cert chain -> AWS Nitro root -> PCRs)
oyster-cvm verify --enclave-ip <ENCLAVE_IP> --image-id <IMAGE_ID>

# 3. Look at the raw attestation document + hit the app
curl http://<ENCLAVE_IP>:1300/attestation/raw | xxd | head
curl http://<ENCLAVE_IP>:8080/
```

`verify` confirms: document structure, certificate-chain signature, root key = AWS Nitro,
attestation age, and that PCR0/1/2 match the expected image. That's the whole trust check.

## Deploy the signing service ([`app/`](app/))

`app/` is now a real **secp256k1 signing service** (not the echo): `/public-key`,
`POST /sign-decision`. It boots with a parity self-test, so a broken build won't run.
Oyster default arch is **arm64** (`base/blue/v3.0.0/arm64`) — build to match.

```bash
# 1. Build + push to a PUBLIC registry (Oyster pulls at runtime).
cd enclave/app
docker buildx build --platform linux/arm64 \
  -t docker.io/<your-dockerhub-user>/treasury-enclave:latest --push .

# 2. Set docker-compose.yml image to yours, then deploy + verify:
cd ..
oyster-cvm build  --docker-compose docker-compose.yml          # expected PCRs / IMAGE_ID for YOUR image
oyster-cvm deploy --wallet-private-key <KEY> --duration-in-minutes 30 \
  --docker-compose docker-compose.yml
oyster-cvm verify --enclave-ip <ENCLAVE_IP> --image-id <IMAGE_ID>

# 3. Talk to the real enclave (its key is generated INSIDE the TEE):
curl -s http://<ENCLAVE_IP>:8080/public-key
curl -s -X POST http://<ENCLAVE_IP>:8080/sign-decision -H 'content-type: application/json' \
  -d '{"treasury":"0x<treasury_id>","amount":1000,"nonce":1}'
```

`verify` confirms the running PCRs match `oyster-cvm build` ("the code running is the code I
built"), and the attestation binds the enclave's secp256k1 public key to those PCRs.

## Register it on Sui (consume the attestation)

The `move/` package verifies decisions from this enclave. To wire them together:

```bash
# publish the package (records PACKAGE_ID + the decision Cap)
cd ../move && sui client publish

# create the EnclaveConfig pinning the PCRs from `oyster-cvm build`/`verify`
# (Cap<DECISION>, name, pcr0, pcr1, pcr2, pcr16) → enclave::create_enclave_config

# register: feed the attestation document → stores the enclave's pubkey on-chain
#   enclave::register_enclave<DECISION>(config, <NitroAttestationDocument>)
# → shared Enclave<DECISION> object whose pk() the verifier checks per decision
```

After that, `decision::execute_decision` accepts a `/sign-decision` signature and releases
bounded funds via `capability::release_for_action`. (Adapt the demo's
[`register_enclave.sh`](https://github.com/marlinprotocol/sui-oyster-demo/blob/main/contracts/script/register_enclave.sh)
for the exact CLI calls.)

## What's proven vs. what's left

- ✅ Local: enclave service signs a decision → Sui `decision.move` verifies the exact signature
  → would release bounded funds (BCS parity self-guarded). See `move/sources/decision.move`.
- ⏭️ Cloud (needs Docker + funded wallets): deploy the signer to Oyster, publish + register the
  `move/` package, and have the agent submit `execute_decision` in a PTB.

Docs: [Oyster quickstart](https://docs.marlin.org/oyster/build-cvm/quickstart) ·
[verify attestations](https://docs.marlin.org/oyster/build-cvm/guides/verify-attestations-oyster-cvm) ·
[Sui + Oyster](https://docs.marlin.org/oyster/build-cvm/guides/sui-oyster/)
