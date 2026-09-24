# syntax=docker/dockerfile:1
# TURBO PALS GRAND PRIX — production image (linux/arm64 on Fargate Graviton).
# Build:  docker build --platform linux/arm64 -t turbo-pals:local .
# Run:    docker run --rm --read-only -p 18080:8080 turbo-pals:local

ARG NODE_IMAGE=node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

# ── build: install the locked toolchain and produce dist/ ─────────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV CI=true NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json ./
RUN npm ci
# .dockerignore limits the context to sources, public assets and build config.
COPY . .
RUN npm run build \
 && test -f dist/client/index.html \
 && test -f dist/server/index.js \
 && test -f dist/server/verify-worker.js \
 && test -f dist/build.json

# ── runtime: Node + the self-contained bundle, nothing else ───────────────────
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    STATIC_DIR=/app/dist/client
WORKDIR /app
# The server bundle inlines every dependency; package managers are not needed at runtime.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
# Files stay root-owned and read-only for the unprivileged runtime user.
COPY --from=build /app/dist ./dist
# uid/gid 1000 is the image's `node` user (ECS task definition runs as 1000:1000).
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "dist/server/index.js"]
