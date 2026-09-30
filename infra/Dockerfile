# syntax=docker/dockerfile:1.7
FROM node:24.19.0-trixie-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/room-core/package.json packages/room-core/package.json
COPY packages/test-fixtures/package.json packages/test-fixtures/package.json
RUN --mount=type=secret,id=proxy_ca,required=false \
    if [ -s /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --global pnpm@11.19.0 && pnpm install --frozen-lockfile
COPY apps apps
COPY packages packages
COPY scripts scripts
COPY tsconfig*.json ./
RUN pnpm build

FROM node:24.19.0-trixie-slim AS runtime
WORKDIR /app
# Signed official Debian packages; optional CA is a BuildKit secret only.
RUN --mount=type=secret,id=proxy_ca,required=false \
    sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && \
    if [ -s /run/secrets/proxy_ca ]; then \
      cat /etc/ssl/certs/ca-certificates.crt /run/secrets/proxy_ca > /tmp/build-ca.pem; \
      printf 'Acquire::https::CaInfo "/tmp/build-ca.pem";\n' > /etc/apt/apt.conf.d/99-build-ca; \
    fi && \
    apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg=7:7.1.5-0+deb13u1 postgresql-client-17=17.11-0+deb13u1 age=1.2.1-1+b5 ca-certificates && \
    rm -rf /var/lib/apt/lists/* /tmp/build-ca.pem /etc/apt/apt.conf.d/99-build-ca && \
    mkdir /data /backups /private && chown node:node /data /backups /private
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/db/migrations ./packages/db/migrations
COPY --chown=node:node infra/entrypoint.sh ./entrypoint.sh
USER node
ENV NODE_ENV=production PG_BIN=/usr/lib/postgresql/17/bin RAVE_AGE_BIN=/usr/bin/age
EXPOSE 3000
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["api"]
