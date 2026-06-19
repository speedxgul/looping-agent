# Build for the arch you deploy with (Oyster default: arm64; pass --platform to match).
#   docker buildx build --platform linux/arm64 -t <user>/treasury-enclave:latest --push .
FROM oven/bun:1.3-slim

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production

COPY decision.ts server.ts ./

EXPOSE 8080
CMD ["bun", "run", "server.ts"]
