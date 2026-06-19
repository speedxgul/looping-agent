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

## Phase B — your own image

```bash
# 1. Build + push to a PUBLIC registry (Oyster pulls at runtime). Match the deploy arch.
cd enclave/app
docker buildx build --platform linux/amd64 \
  -t docker.io/<your-user>/treasury-enclave:latest --push .

# 2. Point docker-compose.yml at your image (uncomment the Phase B block), then:
cd ..
oyster-cvm build --docker-compose docker-compose.yml   # computes IMAGE_ID / PCRs for YOUR image
oyster-cvm deploy --wallet-private-key <KEY> --duration-in-minutes 15 \
  --docker-compose docker-compose.yml --arch amd64
oyster-cvm verify --enclave-ip <ENCLAVE_IP> --image-id <IMAGE_ID>
```

The key idea: **`oyster-cvm build` gives you the expected PCRs for your image**, and
`verify` checks the running enclave reports those same PCRs — i.e. "the code running is the
code I built." That PCR is exactly what a Sui Move verifier would later pin (the Nautilus
`register_enclave` step).

## What this proves vs. what's next

- ✅ Proves: dockerized workload runs in a real Nitro TEE, produces an AWS-signed attestation,
  and the attestation verifies against the expected build (PCRs).
- ⏭️ Next (separate work): map the attestation's enclave public key + PCRs **onto Sui** via the
  Nautilus `enclave` Move module (`register_enclave` + per-request signature verify), and have
  the enclave sign a real *decision* the on-chain verifier checks before funds move.

Docs: [Oyster quickstart](https://docs.marlin.org/oyster/build-cvm/quickstart) ·
[verify attestations](https://docs.marlin.org/oyster/build-cvm/guides/verify-attestations-oyster-cvm)
