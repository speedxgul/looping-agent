FROM oven/bun:1.3.1-slim

WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY test ./test
COPY docs ./docs
COPY README.md ./

ENV NODE_ENV=production
CMD ["bun", "src/index.ts", "run-daemon"]
