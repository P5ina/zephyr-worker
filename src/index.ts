import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { db, rotationJob, user, type RotationJob } from './db.js';
import { ComfyUIClient, type ComfyUIWorkflow } from './comfyui.js';

// Blob storage (using Vercel Blob API directly)
const BLOB_READ_WRITE_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const BLOB_API_URL = 'https://blob.vercel-storage.com';

// Load workflow
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let rotateWorkflow: ComfyUIWorkflow;
try {
	// Try to load from ComfyUI workflows directory first (on Vast.ai)
	const workflowPath = process.env.WORKFLOW_PATH || '/workspace/ComfyUI/user/default/workflows/workflow_rotate.json';
	rotateWorkflow = JSON.parse(readFileSync(workflowPath, 'utf-8'));
	console.log(`[Worker] Loaded workflow from ${workflowPath}`);
} catch {
	// Fallback to local workflow
	try {
		rotateWorkflow = JSON.parse(readFileSync(join(__dirname, '../workflows/rotate_regular.json'), 'utf-8'));
		console.log('[Worker] Loaded workflow from local file');
	} catch {
		console.error('[Worker] Failed to load workflow!');
		process.exit(1);
	}
}

// Map of SaveImage node IDs to directions
const ROTATION_OUTPUT_NODES: Record<string, string> = {
	'69': 'n',
	'40': 'ne',
	'41': 'e',
	'42': 'se',
	'43': 's',
	'53': 'sw',
	'54': 'w',
	'55': 'nw',
};

async function uploadToBlob(data: Buffer, filename: string): Promise<string> {
	if (!BLOB_READ_WRITE_TOKEN) {
		throw new Error('BLOB_READ_WRITE_TOKEN not configured');
	}

	const response = await fetch(`${BLOB_API_URL}/${filename}`, {
		method: 'PUT',
		headers: {
			'Authorization': `Bearer ${BLOB_READ_WRITE_TOKEN}`,
			'Content-Type': 'image/png',
			'x-api-version': '7',
			'x-content-type': 'image/png',
		},
		body: new Uint8Array(data),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Blob upload failed: ${response.status} - ${text}`);
	}

	const result = await response.json() as { url: string };
	return result.url;
}

async function processJob(job: RotationJob): Promise<void> {
	const logPrefix = `[Job:${job.id.slice(0, 8)}]`;
	console.log(`${logPrefix} Processing job (mode: ${job.mode})`);

	const client = new ComfyUIClient();

	try {
		// Connect to WebSocket
		await client.connect();

		// Update job status
		await db.update(rotationJob)
			.set({
				status: 'processing',
				startedAt: new Date(),
				currentStage: 'Connecting to ComfyUI...',
				progress: 0,
			})
			.where(eq(rotationJob.id, job.id));

		// Prepare workflow
		const workflow = JSON.parse(JSON.stringify(rotateWorkflow)) as ComfyUIWorkflow;

		// Set prompt (node 61)
		if (workflow['61']?.inputs) {
			workflow['61'].inputs.value = job.prompt || '';
		}

		// Set seed (node 56)
		if (workflow['56']?.inputs) {
			workflow['56'].inputs.value = Math.floor(Math.random() * 2 ** 32);
		}

		console.log(`${logPrefix} Prompt: "${job.prompt?.substring(0, 50)}..."`);

		// Queue with progress tracking
		const promptId = await client.queuePrompt(workflow, async (info) => {
			const timeInfo = info.estimatedRemainingSeconds > 0
				? ` (~${Math.floor(info.estimatedRemainingSeconds / 60)}:${(info.estimatedRemainingSeconds % 60).toString().padStart(2, '0')} remaining)`
				: '';
			console.log(`${logPrefix} ${info.progress}% - ${info.stage}${timeInfo}`);
			await db.update(rotationJob)
				.set({
					progress: info.progress,
					currentStage: `${info.stage}${timeInfo}`,
				})
				.where(eq(rotationJob.id, job.id));
		});

		// Wait for completion
		const outputs = await client.waitForCompletion(promptId, 600000);

		// Update progress
		await db.update(rotationJob)
			.set({
				progress: 95,
				currentStage: 'Uploading images...',
			})
			.where(eq(rotationJob.id, job.id));

		// Extract and upload images
		const uploadedUrls: Record<string, string> = {};

		for (const [nodeId, output] of Object.entries(outputs)) {
			const direction = ROTATION_OUTPUT_NODES[nodeId];
			const outputData = output as { images?: Array<{ filename: string; subfolder: string; type: string }> };

			if (direction && outputData.images && outputData.images.length > 0) {
				const img = outputData.images[0];
				const imageData = await client.getImage(img.filename, img.subfolder, img.type);
				const blobUrl = await uploadToBlob(imageData, `rotations/${job.id}_${direction}.png`);
				uploadedUrls[direction] = blobUrl;
				console.log(`${logPrefix} Uploaded ${direction.toUpperCase()}`);
			}
		}

		// Update job with results
		await db.update(rotationJob)
			.set({
				status: 'completed',
				progress: 100,
				currentStage: 'Complete',
				rotationN: uploadedUrls.n || null,
				rotationNE: uploadedUrls.ne || null,
				rotationE: uploadedUrls.e || null,
				rotationSE: uploadedUrls.se || null,
				rotationS: uploadedUrls.s || null,
				rotationSW: uploadedUrls.sw || null,
				rotationW: uploadedUrls.w || null,
				rotationNW: uploadedUrls.nw || null,
				completedAt: new Date(),
			})
			.where(eq(rotationJob.id, job.id));

		console.log(`${logPrefix} Completed successfully`);

	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		console.error(`${logPrefix} Failed: ${message}`);

		// Update job as failed
		await db.update(rotationJob)
			.set({
				status: 'failed',
				errorMessage: message,
			})
			.where(eq(rotationJob.id, job.id));

		// Refund tokens
		await db.update(user)
			.set({
				tokens: sql`${user.tokens} + ${job.tokenCost}`,
			})
			.where(eq(user.id, job.userId));

		console.log(`${logPrefix} Tokens refunded`);

	} finally {
		client.disconnect();
	}
}

async function pollForJobs(): Promise<void> {
	console.log('[Worker] Polling for pending jobs...');

	// Find pending jobs
	const pendingJobs = await db.query.rotationJob.findMany({
		where: eq(rotationJob.status, 'pending'),
		orderBy: (rotationJob, { asc }) => [asc(rotationJob.createdAt)],
		limit: 1,
	});

	if (pendingJobs.length === 0) {
		return;
	}

	for (const job of pendingJobs) {
		await processJob(job);
	}
}

async function main(): Promise<void> {
	console.log('[Worker] Starting Zephyr ComfyUI Worker');
	console.log(`[Worker] ComfyUI URL: ${process.env.COMFYUI_URL || 'http://127.0.0.1:8188'}`);

	// Check ComfyUI health
	const client = new ComfyUIClient();
	const healthy = await client.checkHealth();
	if (!healthy) {
		console.error('[Worker] ComfyUI is not healthy, waiting...');
		// Wait and retry
		await new Promise((resolve) => setTimeout(resolve, 5000));
	}

	console.log('[Worker] ComfyUI is ready');

	// Main loop
	while (true) {
		try {
			await pollForJobs();
		} catch (err) {
			console.error('[Worker] Error in poll loop:', err);
		}

		// Wait before next poll
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
}

main().catch((err) => {
	console.error('[Worker] Fatal error:', err);
	process.exit(1);
});
