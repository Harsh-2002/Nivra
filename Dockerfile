# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# The source-built ARM64 base omits the license included in the AMD64 archive.
RUN if [ ! -f /usr/local/LICENSE ]; then \
      wget -q -T 30 -O /usr/local/LICENSE "https://raw.githubusercontent.com/nodejs/node/v${NODE_VERSION}/LICENSE"; \
    fi \
    && echo "5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace  /usr/local/LICENSE" | sha256sum -c -

FROM base AS dependencies
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
COPY scripts ./scripts
COPY src/lib/brand.mjs ./src/lib/brand.mjs
COPY src/lib/pwa.mjs ./src/lib/pwa.mjs
RUN --mount=type=cache,target=/root/.npm npm ci

FROM base AS build
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
ENV NIVRA_DATA_DIR=/tmp/nivra-build-data
RUN npm run build

FROM dependencies AS runtime-binary
RUN strip --strip-unneeded /usr/local/bin/node

FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS production
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 NIVRA_DATA_DIR=/app/data PORT=3000 HOSTNAME=0.0.0.0
RUN apk add --no-cache libstdc++ ca-certificates ffmpeg font-dejavu \
    && addgroup -g 1000 node && adduser -D -u 1000 -G node node \
    && mkdir -m 700 /app/data && chown node:node /app/data
COPY --from=runtime-binary /usr/local/bin/node /usr/local/bin/node
COPY --from=base /usr/local/LICENSE /usr/share/licenses/node/LICENSE
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --chown=node:node LICENSE ./LICENSE
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
