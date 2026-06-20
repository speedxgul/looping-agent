# Build for the arch you deploy with (Oyster default: arm64; pass --platform to match).
#   docker buildx build --platform linux/arm64 -t <user>/treasury-enclave:latest --push .
#
# Reproducibility matters here: the enclave image measurement IS the PCR the attestation
# binds to, so dependencies install --frozen-lockfile and the base image is pinned.
FROM oven/bun:1.3-slim

WORKDIR /app

# Install production deps reproducibly (frozen lockfile -> deterministic image).
COPY --chown=bun:bun package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# The full attested-decision pipeline (server imports decide -> allocation +
# action_intent). decision.ts is the legacy DecisionPayload signer — no longer used.
COPY --chown=bun:bun action_intent.ts allocation.ts decide.ts server.ts ./

# Run as non-root.
USER bun

EXPOSE 8080

# Healthcheck via Bun's fetch (no curl needed in the slim image).
HEALTHCHECK --interval=30s --timeout=3s --start-period=3s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "server.ts"]
