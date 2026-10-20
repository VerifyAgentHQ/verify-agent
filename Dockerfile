FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY vitest.config.mjs README.md ROADMAP.md ./

RUN corepack enable \
  && corepack prepare pnpm@9.12.3 --activate \
  && pnpm install --frozen-lockfile \
  && pnpm run build

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV VERIFY_RESULT_STORE_PATH=/data/verifyagent-results.sqlite

COPY --from=build /app /app
RUN mkdir -p /data \
  && useradd --create-home --uid 10001 verifyagent \
  && chown -R verifyagent:verifyagent /app /data
USER verifyagent

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]
