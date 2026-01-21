# Zephyr Worker

ComfyUI job worker for Zephyr with real-time WebSocket progress tracking.

## Overview

This worker runs on the same Vast.ai instance as ComfyUI. It:
1. Polls the database for pending rotation jobs
2. Processes each job through ComfyUI
3. Tracks progress via WebSocket in real-time
4. Updates the database with progress and results
5. Uploads completed images to Vercel Blob storage

## Setup on Vast.ai

### 1. Clone to the instance

```bash
cd /workspace
git clone <repo-url> zephyr-worker
cd zephyr-worker
```

### 2. Install Node.js (if not present)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env with your database URL and Vercel Blob token
nano .env
```

### 4. Install dependencies and build

```bash
npm install
npm run build
```

### 5. Run the worker

```bash
# Run in foreground (for testing)
npm start

# Or run in background with nohup
nohup npm start > worker.log 2>&1 &

# Or use screen/tmux
screen -S worker
npm start
# Ctrl+A, D to detach
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` or `POSTGRES_URL` | PostgreSQL connection string | Required |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob storage token | Required |
| `COMFYUI_URL` | ComfyUI API URL | `http://127.0.0.1:8188` |
| `WORKFLOW_PATH` | Path to workflow JSON | `/workspace/ComfyUI/user/default/workflows/workflow_rotate.json` |

## How It Works

1. **Job Polling**: Worker polls database every 2s for `status='pending'` jobs
2. **WebSocket Progress**: Connects to ComfyUI WebSocket to receive real-time execution updates
3. **Progress Mapping**: Maps ComfyUI node execution to human-readable stages and percentages
4. **Database Updates**: Updates job progress in real-time (progress %, current stage)
5. **Image Upload**: On completion, uploads all 8 rotation images to Vercel Blob
6. **Error Handling**: On failure, marks job as failed and refunds tokens

## Development

```bash
# Run with hot reload
npm run dev
```
