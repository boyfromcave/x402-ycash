# The x402 Ycash facilitator. Build from the repository root:
#   docker build -f packages/facilitator/Dockerfile -t x402-ycash-facilitator .
# Run against a node (see the README's "Facilitator" for every variable):
#   docker run -p 4022:4022 -v x402-data:/data -e X402_NETWORK=ycash:mainnet \
#     -e X402_RPC_URL=http://node:8232 -e X402_RPC_USER=… -e X402_RPC_PASSWORD=… x402-ycash-facilitator

FROM node:22-slim AS manifests
WORKDIR /app
# Every workspace manifest, so `npm ci` matches the lockfile; only two workspaces get installed.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/ycash/package.json packages/ycash/
COPY packages/facilitator/package.json packages/facilitator/
COPY packages/cli/package.json packages/cli/
COPY examples/merchant-express/package.json examples/merchant-express/
COPY examples/agent-client/package.json examples/agent-client/

FROM manifests AS build
RUN npm ci --workspace x402-ycash-mechanism --workspace x402-ycash-facilitator
COPY packages/ycash packages/ycash
COPY packages/facilitator packages/facilitator
RUN npm run build --workspace x402-ycash-mechanism --workspace x402-ycash-facilitator

FROM manifests AS deps
RUN npm ci --omit=dev --workspace x402-ycash-mechanism --workspace x402-ycash-facilitator \
 && mkdir -p packages/ycash/node_modules packages/facilitator/node_modules

FROM node:22-slim
ENV NODE_ENV=production \
    X402_HOST=0.0.0.0 \
    X402_PORT=4022 \
    X402_SETTLEMENT_STORE=/data/settlements.json \
    X402_CHANNEL_STORE=/data/channels.json
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
# npm nests a workspace's dependency there when another package needs a different major
# (@noble/curves 2.x for the mechanism vs 1.x elsewhere), so the workspace trees are copied too.
COPY --from=deps /app/packages/ycash/node_modules packages/ycash/node_modules
COPY --from=deps /app/packages/facilitator/node_modules packages/facilitator/node_modules
COPY --from=build /app/packages/ycash/package.json packages/ycash/
COPY --from=build /app/packages/ycash/dist packages/ycash/dist
# The lightwalletd protos, loaded at run time by the lwd client (src/lwd/client.ts).
COPY --from=build /app/packages/ycash/proto packages/ycash/proto
COPY --from=build /app/packages/facilitator/package.json packages/facilitator/
COPY --from=build /app/packages/facilitator/dist packages/facilitator/dist
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 4022
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.X402_PORT||4022)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Node is PID 1 and handles SIGTERM itself (graceful shutdown in server.ts).
CMD ["node", "packages/facilitator/dist/main.js"]
