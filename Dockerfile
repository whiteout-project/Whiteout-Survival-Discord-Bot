# Stage 1: Build native dependencies
FROM node:22-slim AS builder

WORKDIR /app

# Install build tools needed for native modules (better-sqlite3, sharp, onnxruntime)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files first for Docker layer caching
COPY package.json package-lock.json ./

# Install all dependencies and build native modules
RUN npm ci && \
    # Strip unused platform binaries and GPU providers from onnxruntime-node (~549MB saved)
    rm -rf node_modules/onnxruntime-node/bin/napi-v6/darwin \
           node_modules/onnxruntime-node/bin/napi-v6/win32 \
           node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_cuda.so \
           node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_tensorrt.so

# Stage 2: Production image
FROM node:22-slim

WORKDIR /app

# Install only runtime libraries needed by native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips42 \
    && rm -rf /var/lib/apt/lists/*

# Patch CVE-2026-33671: replace picomatch 4.0.3 with 4.0.4 in npm's bundled deps
RUN cd /usr/local/lib/node_modules/npm/node_modules && \
    rm -rf picomatch && \
    npm pack picomatch@4.0.4 --pack-destination . 2>/dev/null && \
    tar xzf picomatch-4.0.4.tgz && \
    mv package picomatch && \
    rm -f picomatch-4.0.4.tgz

# Copy node_modules from builder (includes compiled native binaries)
COPY --from=builder /app/node_modules ./node_modules

# Copy application source code
COPY package.json ./
COPY starter.js ./
COPY src/ ./src/

# Create directories for persistent data (will be mounted as volumes)
RUN mkdir -p src/database plugins src/temp

# Set memory limit and expose-gc for the bot
ENV NODE_OPTIONS="--max-old-space-size=256 --expose-gc"
ENV DOCKER_CONTAINER=1

CMD ["node", "starter.js"]
