FROM node:22-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/fix-node-pty.js ./scripts/fix-node-pty.js
RUN HUSKY=0 npm ci --no-audit --no-fund
COPY . .
RUN VITE_CLOUDCLI_CONTAINER_DEPLOYMENT=true npm run build && npm prune --omit=dev --no-audit --no-fund

# docli, the KeyDev Word/Excel CLI, is not published; a deployment places its wheel in docker/vendor/ before building.
# This stage only checks for the wheel. Nothing else depends on it until the docli install below, so BuildKit runs it
# alongside the other stages and a missing wheel stops the build at once with a clear error, while a changed wheel
# rebuilds nothing but the docli layer. docker/vendor/ always holds a README, so the COPY never fails on its own.
FROM node:22-bookworm-slim AS docli-wheel
COPY docker/vendor/ /vendor/
RUN ls /vendor/docli-*.whl > /dev/null 2>&1 || { \
      echo "ERROR: docker/vendor/docli-<version>-py3-none-any.whl is missing." >&2; \
      echo "docli is an internal tool and is not committed. Copy its wheel from key_dev_docs/ into docker/vendor/ and build again (see docker/vendor/README.md)." >&2; \
      exit 1; }

FROM node:22-bookworm-slim

ARG SOURCE_REVISION=local
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
ARG CLAUDE_CODE_VERSION=2.1.288
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git libreoffice-calc libreoffice-writer openssh-client python3 python3-docx python3-openpyxl python3-venv poppler-utils unzip \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" --no-audit --no-fund

WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/public ./public

RUN mkdir -p /workspace /home/node/.cloudcli && chown -R node:node /workspace /home/node

# The wheel is bind-mounted, so it never lands in an image layer.
RUN --mount=type=bind,from=docli-wheel,source=/vendor,target=/mnt/vendor \
    python3 -m venv /opt/docli \
    && /opt/docli/bin/pip install --no-cache-dir /mnt/vendor/docli-*.whl \
    && ln -s /opt/docli/bin/docli /usr/local/bin/docli \
    && docli word --help > /dev/null && docli excel --help > /dev/null
# LibreOffice opens files users upload; never run macros from them, whatever a profile says.
COPY docker/libreoffice-hardening.xcd /usr/lib/libreoffice/share/registry/zz-keydev-hardening.xcd
COPY --from=build /app/docker/agent-instructions.md ./agent-instructions.md

# The CLI version is pinned by CLAUDE_CODE_VERSION; the node user cannot write the global npm prefix anyway.
# claude.ai connectors belong to the signed-in account (mail, drive, calendar); every user of this server would share them.
ENV NODE_ENV=production \
    DISABLE_AUTOUPDATER=1 \
    ENABLE_CLAUDEAI_MCP_SERVERS=false \
    HOME=/home/node \
    HOST=0.0.0.0 \
    SERVER_PORT=3001 \
    DATABASE_PATH=/home/node/.cloudcli/auth.db \
    CLOUDCLI_AGENT_INSTRUCTIONS_FILE=/app/agent-instructions.md \
    PATH=/app/node_modules/.bin:$PATH

USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/server/index.js"]
