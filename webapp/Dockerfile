# The writing instance, packaged for a machine that is nobody's.
#
# Build context is webapp/ (this directory). The image runs
# tools/cloud-writer-boot.mjs: adopt the journal branch or the published
# archive (verified), serve as the writer, journal every act back to git.
# See CLOUD-WRITER.md for the whole story and the env it expects.
#
# npm is needed at BUILD time only (esbuild assembles the app page); the
# server itself is dependency-free, so the final layer carries no node_modules.

FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN node social/assemble.mjs && rm -rf node_modules

# The one writable place. Platforms with a volume should mount it here;
# platforms without one lose this dir on every restart — that is exactly the
# case the journal branch exists for.
ENV PEER_DATA_DIR=/data
EXPOSE 5210

CMD ["node", "tools/cloud-writer-boot.mjs"]
