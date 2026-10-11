# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 ONNXRUNTIME_NODE_INSTALL=skip
RUN if [ ! -f /usr/local/LICENSE ]; then node -e "fetch('https://raw.githubusercontent.com/nodejs/node/v'+process.versions.node+'/LICENSE').then(async r=>{if(!r.ok)throw Error('Node license unavailable');require('node:fs').writeFileSync('/usr/local/LICENSE',await r.text())})"; fi && echo "5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace  /usr/local/LICENSE" | sha256sum -c -

FROM base AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY scripts ./scripts
COPY src/lib/brand.mjs ./src/lib/brand.mjs
COPY src/lib/pwa.mjs ./src/lib/pwa.mjs
RUN --mount=type=cache,target=/root/.npm npm ci

FROM dependencies AS model
COPY src/lib/server/ai/model-manifest.json ./src/lib/server/ai/model-manifest.json
RUN npm run ai:assets

FROM base AS build
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
ENV NIVRA_DATA_DIR=/tmp/nivra-build-data
RUN npm run build && node scripts/prune-ai-runtime.mjs

FROM dependencies AS runtime-binary
RUN strip --strip-unneeded /usr/local/bin/node

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS production
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 NIVRA_DATA_DIR=/app/data PORT=3000 HOSTNAME=0.0.0.0
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 ca-certificates ffmpeg fonts-dejavu-core util-linux && rm -rf /var/lib/apt/lists/* && groupadd --gid 1000 node && useradd --uid 1000 --gid node --create-home node && mkdir -m 700 /app/data && chown node:node /app/data
COPY --from=runtime-binary /usr/local/bin/node /usr/local/bin/node
COPY --from=base /usr/local/LICENSE /usr/share/licenses/node/LICENSE
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=model --chown=node:node /app/models ./models
COPY --chown=node:node scripts/smoke-ai-runtime.mjs ./scripts/smoke-ai-runtime.mjs
COPY --chown=node:node LICENSE ./LICENSE
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
