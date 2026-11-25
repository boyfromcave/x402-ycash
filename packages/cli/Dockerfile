# Copyright (c) 2026 The Ycash developers. MIT License.
#
# The paying side: the x402-ycash CLI and the reference agent of the chain-data API
# (x402-chain-agent). Build from the repository root:
#   docker build -f packages/cli/Dockerfile -t x402-ycash-cli .
# Use (README "Pay it from an agent in five minutes"); run as yourself so the key file is yours:
#   docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/w" x402-ycash-cli key new /w/agent.wif --network ycash:testnet
#   docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/w" --entrypoint x402-chain-agent x402-ycash-cli \
#     https://fastnet-x402.ycash.team --wif-file /w/agent.wif --lwd fastnet-lightwallet.ycash.team:443 --reservations /w/reservations.json
# The image holds no key: keys live in the mounted directory, mode 0600.

FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS manifests
WORKDIR /app
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

FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
ENV NODE_ENV=production \
    HOME=/tmp
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
RUN printf '#!/bin/sh\nexec node /app/packages/cli/dist/main.js "$@"\n' > /usr/local/bin/x402-ycash \
 && printf '#!/bin/sh\nexec node /app/examples/chain-api/dist/agent/main.js "$@"\n' > /usr/local/bin/x402-chain-agent \
 && chmod 0755 /usr/local/bin/x402-ycash /usr/local/bin/x402-chain-agent
USER node
WORKDIR /w
ENTRYPOINT ["x402-ycash"]
