import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { db, rotationJob, assetGeneration, textureGeneration, user, type RotationJob, type AssetGeneration, type TextureGeneration } from './db.js';
import { ComfyUIClient, type ComfyUIWorkflow, type ProgressInfo } from './comfyui.js';
import { readFileSync, existsSync } from 'fs';

// Blob storage
const BLOB_READ_WRITE_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const BLOB_API_URL = 'https://blob.vercel-storage.com';

// Workflow paths
const WORKFLOW_DIR = process.env.WORKFLOW_DIR || '/workspace/zephyr-worker';

// Load workflows
function loadWorkflow(name: string): ComfyUIWorkflow | null {
	const paths = [
		`${WORKFLOW_DIR}/${name}.json`,
		`${WORKFLOW_DIR}/workflow_${name}.json`,
	];

	for (const path of paths) {
		if (existsSync(path)) {
			try {
				const wf = JSON.parse(readFileSync(path, 'utf-8'));
				console.log(`[Worker] Loaded workflow: ${name} from ${path}`);
				return wf;
			} catch (err) {
				console.error(`[Worker] Failed to parse ${path}:`, err);
			}
		}
	}
	return null;
}

const workflows: Record<string, ComfyUIWorkflow | null> = {
	rotate: loadWorkflow('workflow'),
	sprite: loadWorkflow('sprite'),
	texture: loadWorkflow('texture'),
};

// Rotation output node mapping
const ROTATION_OUTPUT_NODES: Record<string, string> = {
	'69': 'n', '40': 'ne', '41': 'e', '42': 'se',
	'43': 's', '53': 'sw', '54': 'w', '55': 'nw',
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

function formatProgress(info: ProgressInfo): string {
	const timeInfo = info.estimatedRemainingSeconds > 0
		? ` (~${Math.floor(info.estimatedRemainingSeconds / 60)}:${(info.estimatedRemainingSeconds % 60).toString().padStart(2, '0')} remaining)`
		: '';
	return `${info.stage}${timeInfo}`;
}

// ============ ROTATION JOBS ============
async function processRotationJob(job: RotationJob): Promise<void> {
	const logPrefix = `[Rotate:${job.id.slice(0, 8)}]`;
	console.log(`${logPrefix} Processing (mode: ${job.mode})`);

	if (!workflows.rotate) {
		throw new Error('Rotation workflow not loaded');
	}

	const client = new ComfyUIClient();

	try {
		await client.connect();

		await db.update(rotationJob)
			.set({ status: 'processing', startedAt: new Date(), currentStage: 'Starting...', progress: 0 })
			.where(eq(rotationJob.id, job.id));

		const workflow = JSON.parse(JSON.stringify(workflows.rotate)) as ComfyUIWorkflow;

		// Set prompt (node 61) and seed (node 56)
		if (workflow['61']?.inputs) workflow['61'].inputs.value = job.prompt || '';
		if (workflow['56']?.inputs) workflow['56'].inputs.value = Math.floor(Math.random() * 2 ** 32);

		console.log(`${logPrefix} Prompt: "${job.prompt?.substring(0, 50)}..."`);

		const promptId = await client.queuePrompt(workflow, async (info) => {
			console.log(`${logPrefix} ${info.progress}% - ${info.stage}`);
			await db.update(rotationJob)
				.set({ progress: info.progress, currentStage: formatProgress(info) })
				.where(eq(rotationJob.id, job.id));
		});

		const outputs = await client.waitForCompletion(promptId, 600000);

		await db.update(rotationJob)
			.set({ progress: 95, currentStage: 'Uploading images...' })
			.where(eq(rotationJob.id, job.id));

		const uploadedUrls: Record<string, string> = {};
		for (const [nodeId, output] of Object.entries(outputs)) {
			const direction = ROTATION_OUTPUT_NODES[nodeId];
			const outputData = output as { images?: Array<{ filename: string; subfolder: string; type: string }> };

			if (direction && outputData.images?.length) {
				const img = outputData.images[0];
				const imageData = await client.getImage(img.filename, img.subfolder, img.type);
				uploadedUrls[direction] = await uploadToBlob(imageData, `rotations/${job.id}_${direction}.png`);
				console.log(`${logPrefix} Uploaded ${direction.toUpperCase()}`);
			}
		}

		await db.update(rotationJob)
			.set({
				status: 'completed', progress: 100, currentStage: 'Complete',
				rotationN: uploadedUrls.n, rotationNE: uploadedUrls.ne, rotationE: uploadedUrls.e, rotationSE: uploadedUrls.se,
				rotationS: uploadedUrls.s, rotationSW: uploadedUrls.sw, rotationW: uploadedUrls.w, rotationNW: uploadedUrls.nw,
				completedAt: new Date(),
			})
			.where(eq(rotationJob.id, job.id));

		console.log(`${logPrefix} Completed`);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		console.error(`${logPrefix} Failed: ${message}`);

		await db.update(rotationJob).set({ status: 'failed', errorMessage: message }).where(eq(rotationJob.id, job.id));
		await db.update(user).set({ tokens: sql`${user.tokens} + ${job.tokenCost}` }).where(eq(user.id, job.userId));
		console.log(`${logPrefix} Tokens refunded`);
	} finally {
		client.disconnect();
	}
}

// ============ ASSET JOBS ============
async function processAssetJob(job: AssetGeneration): Promise<void> {
	const logPrefix = `[Asset:${job.id.slice(0, 8)}]`;
	console.log(`${logPrefix} Processing (type: ${job.assetType})`);

	if (!workflows.sprite) {
		throw new Error('Sprite workflow not loaded');
	}

	const client = new ComfyUIClient();

	try {
		await client.connect();

		await db.update(assetGeneration)
			.set({ status: 'processing', currentStage: 'Starting...', progress: 0 })
			.where(eq(assetGeneration.id, job.id));

		const workflow = JSON.parse(JSON.stringify(workflows.sprite)) as ComfyUIWorkflow;

		// Find and set prompt/dimensions in workflow (adjust node IDs as needed)
		for (const [nodeId, node] of Object.entries(workflow)) {
			if (node.class_type === 'CLIPTextEncode' && node.inputs.text !== undefined) {
				node.inputs.text = job.prompt;
			}
			if ((node.class_type === 'EmptyLatentImage' || node.class_type === 'EmptySD3LatentImage') && node.inputs.width !== undefined) {
				node.inputs.width = job.width;
				node.inputs.height = job.height;
			}
			if (node.class_type === 'KSampler' && node.inputs.seed !== undefined) {
				node.inputs.seed = Math.floor(Math.random() * 2 ** 32);
			}
		}

		console.log(`${logPrefix} Prompt: "${job.prompt?.substring(0, 50)}..."`);

		const promptId = await client.queuePrompt(workflow, async (info) => {
			console.log(`${logPrefix} ${info.progress}% - ${info.stage}`);
			await db.update(assetGeneration)
				.set({ progress: info.progress, currentStage: formatProgress(info) })
				.where(eq(assetGeneration.id, job.id));
		});

		const outputs = await client.waitForCompletion(promptId, 300000);

		await db.update(assetGeneration)
			.set({ progress: 95, currentStage: 'Uploading image...' })
			.where(eq(assetGeneration.id, job.id));

		// Find output image
		let imageUrl: string | null = null;
		for (const output of Object.values(outputs)) {
			const outputData = output as { images?: Array<{ filename: string; subfolder: string; type: string }> };
			if (outputData.images?.length) {
				const img = outputData.images[0];
				const imageData = await client.getImage(img.filename, img.subfolder, img.type);
				imageUrl = await uploadToBlob(imageData, `assets/${job.id}.png`);
				break;
			}
		}

		if (!imageUrl) {
			throw new Error('No output image generated');
		}

		await db.update(assetGeneration)
			.set({
				status: 'completed', progress: 100, currentStage: 'Complete',
				resultUrls: { raw: imageUrl },
				completedAt: new Date(),
			})
			.where(eq(assetGeneration.id, job.id));

		console.log(`${logPrefix} Completed`);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		console.error(`${logPrefix} Failed: ${message}`);

		await db.update(assetGeneration).set({ status: 'failed', errorMessage: message }).where(eq(assetGeneration.id, job.id));
		await db.update(user).set({ tokens: sql`${user.tokens} + ${job.tokenCost}` }).where(eq(user.id, job.userId));
		console.log(`${logPrefix} Tokens refunded`);
	} finally {
		client.disconnect();
	}
}

// ============ TEXTURE JOBS ============
async function processTextureJob(job: TextureGeneration): Promise<void> {
	const logPrefix = `[Texture:${job.id.slice(0, 8)}]`;
	console.log(`${logPrefix} Processing`);

	if (!workflows.texture) {
		// Texture workflow not available yet - fail gracefully
		await db.update(textureGeneration)
			.set({ status: 'failed', errorMessage: 'Texture generation workflow not yet configured' })
			.where(eq(textureGeneration.id, job.id));
		await db.update(user).set({ tokens: sql`${user.tokens} + ${job.tokenCost}` }).where(eq(user.id, job.userId));
		console.log(`${logPrefix} Workflow not ready, tokens refunded`);
		return;
	}

	const client = new ComfyUIClient();

	try {
		await client.connect();

		await db.update(textureGeneration)
			.set({ status: 'processing', currentStage: 'Starting...', progress: 0 })
			.where(eq(textureGeneration.id, job.id));

		// TODO: Implement texture workflow processing
		// This will generate PBR maps (basecolor, normal, roughness, metallic, height)

		throw new Error('Texture generation not yet implemented');
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		console.error(`${logPrefix} Failed: ${message}`);

		await db.update(textureGeneration).set({ status: 'failed', errorMessage: message }).where(eq(textureGeneration.id, job.id));
		await db.update(user).set({ tokens: sql`${user.tokens} + ${job.tokenCost}` }).where(eq(user.id, job.userId));
		console.log(`${logPrefix} Tokens refunded`);
	} finally {
		client.disconnect();
	}
}

// ============ MAIN LOOP ============
async function pollForJobs(): Promise<void> {
	// Check rotation jobs
	const rotationJobs = await db.query.rotationJob.findMany({
		where: eq(rotationJob.status, 'pending'),
		orderBy: (rotationJob, { asc }) => [asc(rotationJob.createdAt)],
		limit: 1,
	});

	for (const job of rotationJobs) {
		await processRotationJob(job);
		return; // Process one job at a time
	}

	// Check asset jobs
	const assetJobs = await db.query.assetGeneration.findMany({
		where: eq(assetGeneration.status, 'pending'),
		orderBy: (assetGeneration, { asc }) => [asc(assetGeneration.createdAt)],
		limit: 1,
	});

	for (const job of assetJobs) {
		await processAssetJob(job);
		return;
	}

	// Check texture jobs
	const textureJobs = await db.query.textureGeneration.findMany({
		where: eq(textureGeneration.status, 'pending'),
		orderBy: (textureGeneration, { asc }) => [asc(textureGeneration.createdAt)],
		limit: 1,
	});

	for (const job of textureJobs) {
		await processTextureJob(job);
		return;
	}
}

async function main(): Promise<void> {
	console.log('[Worker] Starting Zephyr ComfyUI Worker');
	console.log(`[Worker] ComfyUI URL: ${process.env.COMFYUI_URL || 'http://127.0.0.1:8188'}`);
	console.log(`[Worker] Workflows loaded: ${Object.entries(workflows).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);

	const client = new ComfyUIClient();
	let healthy = await client.checkHealth();
	while (!healthy) {
		console.log('[Worker] Waiting for ComfyUI...');
		await new Promise((resolve) => setTimeout(resolve, 5000));
		healthy = await client.checkHealth();
	}
	console.log('[Worker] ComfyUI is ready');

	while (true) {
		try {
			await pollForJobs();
		} catch (err) {
			console.error('[Worker] Error:', err);
		}
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
}

main().catch((err) => {
	console.error('[Worker] Fatal error:', err);
	process.exit(1);
});
