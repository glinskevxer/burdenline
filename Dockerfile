# Two stages. The first installs everything including the dev dependencies so the
# native build of better-sqlite3 has what it needs; the second copies only the
# production tree across. The image runs as a user with no write access to the
# application directory, and the database lives on a volume that is the only
# writable path in the container.

FROM node:20.18.1-bookworm-slim AS build
WORKDIR /app

# The lock file is copied on its own so a change to the source does not
# invalidate the layer that installed the dependencies.
COPY package.json package-lock.json ./
RUN apt-get update \
 && apt-get install --no-install-recommends -y python3 make g++ \
 && npm ci \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY src ./src
COPY bin ./bin
RUN npm prune --omit=dev

FROM node:20.18.1-bookworm-slim AS runtime
ENV NODE_ENV=production \
    BURDENLINE_HOST=0.0.0.0 \
    BURDENLINE_PORT=8080 \
    BURDENLINE_DB=/data/burdenline.db \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app
RUN mkdir -p /data && chown node:node /data

COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/src ./src
COPY --from=build --chown=root:root /app/bin ./bin
COPY --chown=root:root package.json ./

USER node
VOLUME ["/data"]
EXPOSE 8080

# The container is unhealthy the moment the database stops answering, not just
# when the process dies, because a server that is up and cannot read the day-book
# is no use to anybody on the bench.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BURDENLINE_PORT||8080)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
