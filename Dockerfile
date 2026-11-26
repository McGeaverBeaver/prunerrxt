# ============================================
# PrunerrXT - Multi-stage Docker Build
# ============================================

# Stage 1: Build the client application
FROM node:24-alpine3.24 AS client-builder

WORKDIR /app/client

# Copy client package files
COPY client/package*.json ./

# Install client dependencies from the lockfile. `npm ci` is exact and fails
# loudly if package.json and package-lock.json disagree, so a release can never
# quietly resolve a different tree than the one that was tested.
RUN npm ci

# Copy client source code
COPY client/ ./

# Build the client
RUN npm run build

# ============================================
# Stage 2: Build the server application
FROM node:24-alpine3.24 AS server-builder

WORKDIR /app/server

# Build dependencies for better-sqlite3's native module. They stay in this
# stage; the production image never sees a compiler or headers.
RUN apk add --no-cache python3 make g++

# Copy server package files
COPY server/package*.json ./

# Install all dependencies (including devDependencies for build) from the
# lockfile — exact, and fails loudly on drift.
RUN npm ci

# Copy server source code
COPY server/ ./

# Build the server
RUN npm run build

# Prune dev dependencies - keep only production deps (already compiled for target arch)
RUN npm prune --omit=dev

# ============================================
# Stage 3: Production image
#
# Plain Alpine plus the Node binary only. The official node image also ships
# npm, npx, corepack and yarn, which nothing in PrunerrXT runs (the server has
# no child_process calls and the entrypoint only starts `node dist/index.js`);
# leaving them behind takes their bundled dependencies, and the CVEs that come
# with them, out of the image. Both images are pinned to the same Alpine
# release so the musl, libstdc++ and libgcc the binary was built for match.
FROM node:24-alpine3.24 AS node-runtime

FROM alpine:3.24 AS production

# Build argument for version (passed from CI/CD)
ARG APP_VERSION=1.0.0

# Labels for container metadata
LABEL org.opencontainers.image.title="PrunerrXT"
LABEL org.opencontainers.image.description="Media library cleanup tool for Plex/Sonarr/Radarr"
LABEL org.opencontainers.image.version="${APP_VERSION}"
LABEL org.opencontainers.image.vendor="PrunerrXT"
LABEL org.opencontainers.image.source="https://github.com/McGeaverBeaver/prunerrxt"
LABEL org.opencontainers.image.licenses="MIT"

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node

# - apk upgrade picks up Alpine fixes newer than the base image.
# - libstdc++ and libgcc are the only shared libraries the Node binary loads
#   besides musl.
# - su-exec switches to PUID:PGID at startup (docker-entrypoint.sh).
# - ca-certificates-bundle is listed so removing apk-tools below keeps it.
# - setcap gives the Node binary CAP_CHOWN and CAP_FOWNER so PrunerrXT, running
#   unprivileged, can still set the owner and mode of media files written by
#   other users (a DVR running as root, a download client as another id) when
#   cleaning up or importing unmanaged folders. Those two capabilities allow
#   exactly that and nothing else; file access checks still apply. The app
#   reads its capabilities from /proc, so libcap-utils is only needed for this
#   one command and is removed again.
# - apk itself goes last: nothing installs packages at runtime. Its database
#   stays, so image scanners still see every package.
RUN apk upgrade --no-cache \
    && apk add --no-cache libstdc++ libgcc su-exec ca-certificates-bundle \
    && apk add --no-cache --virtual .setcap libcap-utils \
    && setcap 'cap_chown,cap_fowner+ep' /usr/local/bin/node \
    && apk del --no-cache .setcap \
    && apk del --no-cache apk-tools \
    && node --version

WORKDIR /app

# Default user; docker-entrypoint.sh re-creates it with PUID/PGID at startup.
RUN addgroup -g 1001 -S prunerr && \
    adduser -S prunerr -u 1001 -G prunerr

# The application stays owned by root and read-only to the user it runs as.
# Only /app (for logs/) and /app/data are handed to PUID:PGID, by the entrypoint.
COPY --from=server-builder /app/server/node_modules ./node_modules
COPY server/package.json ./
COPY --from=server-builder /app/server/dist ./dist
COPY --from=client-builder /app/client/dist ./public
COPY --chmod=755 docker-entrypoint.sh /docker-entrypoint.sh

# Create data directory for SQLite database
RUN mkdir -p /app/data && chown prunerr:prunerr /app /app/data

# The container starts as root only so the entrypoint can re-map the prunerr
# user to PUID/PGID and chown /app/data; it then drops to PUID:PGID with
# su-exec before Node starts. No USER directive for that reason.

# Expose the application port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV APP_VERSION=${APP_VERSION}

# Health check in Node itself, so the image needs no wget or curl.
# (10s start-period allows for Node.js startup)
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health',{signal:AbortSignal.timeout(8000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Start via entrypoint (handles PUID/PGID user switching)
ENTRYPOINT ["/docker-entrypoint.sh"]
