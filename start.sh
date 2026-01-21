#!/bin/bash

# Zephyr Worker Startup Script for Vast.ai
# Run this alongside ComfyUI on the same instance

set -e

cd /workspace/zephyr-worker

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "[Worker] Installing dependencies..."
    npm install
fi

# Build TypeScript
echo "[Worker] Building TypeScript..."
npm run build

# Start worker
echo "[Worker] Starting worker..."
exec node dist/index.js
