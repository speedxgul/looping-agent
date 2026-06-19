# Build for the arch you deploy with (Oyster: match `--arch`, default arm64).
# From the repo root or enclave/app/:
#   docker buildx build --platform linux/amd64 -t <user>/treasury-enclave:latest --push .
#   (use linux/arm64 if deploying with the default arch)
FROM oven/bun:1.3-slim

WORKDIR /app
COPY server.ts .

EXPOSE 8080
CMD ["bun", "run", "server.ts"]
