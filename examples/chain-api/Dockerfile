# Copyright (c) 2026 The Ycash developers. MIT License.
#
# The paid chain-data API (x402-ycash-chain-api). Build from the repository root:
#   docker build -f examples/chain-api/Dockerfile -t x402-ycash-chain-api .
# Run beside a node (-insightexplorer -txindex) and the facilitator (README "Run the paid API"):
#   docker run -p 4021:4021 -e API_PAY_TO=sm… -e API_RPC_URL=http://node:18232 \
#     -e API_RPC_COOKIE_FILE=/node/.cookie -v node-cookie:/node:ro -e FACILITATOR_URL=http://facilitator:4022 \
#     x402-ycash-chain-api
# It holds no key: payments go to API_PAY_TO, an address of a wallet kept elsewhere. Read-only root
# file system friendly: it writes nothing.

FROM node:22-slim AS manifests
WORKDIR /app
# Every workspace manifest, so `npm ci` matches the lockfile; only the three needed get installed.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/ycash/package.json packages/ycash/
COPY packages/facilitator/package.json packages/facilitator/
COPY packages/cli/package.json packages/cli/
COPY examples/merchant-express/package.json examples/merchant-express/
COPY examples/agent-client/package.json examples/agent-client/
COPY examples/chain-api/package.json examples/chain-api/

FROM manifests AS build
RUN npm ci --workspace x402-ycash-mechanism --workspace x402-ycash-cli --workspace x402-ycash-chain-api
COPY packages/ycash packages/ycash
COPY packages/cli packages/cli
COPY examples/chain-api examples/chain-api
RUN npm run build --workspace x402-ycash-mechanism --workspace x402-ycash-cli --workspace x402-ycash-chain-api

FROM manifests AS deps
RUN npm ci --omit=dev --workspace x402-ycash-mechanism --workspace x402-ycash-cli --workspace x402-ycash-chain-api \
 && mkdir -p packages/ycash/node_modules packages/cli/node_modules examples/chain-api/node_modules

FROM node:22-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4021
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/packages/ycash/node_modules packages/ycash/node_modules
COPY --from=deps /app/packages/cli/node_modules packages/cli/node_modules
COPY --from=deps /app/examples/chain-api/node_modules examples/chain-api/node_modules
COPY --from=build /app/packages/ycash/package.json packages/ycash/
COPY --from=build /app/packages/ycash/dist packages/ycash/dist
COPY --from=build /app/packages/ycash/proto packages/ycash/proto
COPY --from=build /app/packages/cli/package.json packages/cli/
COPY --from=build /app/packages/cli/dist packages/cli/dist
COPY --from=build /app/examples/chain-api/package.json examples/chain-api/
COPY --from=build /app/examples/chain-api/dist examples/chain-api/dist
USER node
EXPOSE 4021
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4021)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Node is PID 1 and handles SIGTERM itself (main.ts).
CMD ["node", "examples/chain-api/dist/main.js"]
