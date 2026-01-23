import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { db, rotationJob, assetGeneration, textureGeneration, user, type RotationJob, type AssetGeneration, type TextureGeneration } from './db.js';
import { ComfyUIClient, type ComfyUIWorkflow, type ProgressInfo } from './comfyui.js';
import { readFileSync, existsSync } from 'fs';

// Blob storage
const BLOB_READ_WRITE_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const BLOB_API_URL = 'https://blob.vercel-storage.com';

// Workflow paths
const WORKFLOW_DIR = process.env.WORKFLOW_DIR || './workflows';

// Load workflows
function loadWorkflow(name: string): ComfyUIWorkflow | null {
	const paths = [
		`${WORKFLOW_DIR}/${name}.json`,
		`${WORKFLOW_DIR}/workflow_${name}.json`,
		`${WORKFLOW_DIR}/rotate_${name}.json`,
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
	rotate: loadWorkflow('regular') || loadWorkflow('workflow'),
	sprite: loadWorkflow('sprite'),
	texture: loadWorkflow('texture'),
};

// SV3D workflow outputs all 8 directions from node 129 as a batch
// Frame indices in the batch correspond to directions:
// 0=N, 1=NE, 2=E, 3=SE, 4=S, 5=SW, 6=W, 7=NW
const ROTATION_DIRECTIONS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;

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
	console.log(`${logPrefix} Processing`);

	if (!workflows.rotate) {
		throw new Error('Rotation workflow not loaded');
	}

	if (!job.inputImageUrl) {
		throw new Error('No input image provided');
	}

	const client = new ComfyUIClient();

	try {
		await client.connect();

		await db.update(rotationJob)
			.set({ status: 'processing', startedAt: new Date(), currentStage: 'Downloading input image...', progress: 0 })
			.where(eq(rotationJob.id, job.id));

		// Download input image from URL
		console.log(`${logPrefix} Downloading input image...`);
		const imageResponse = await fetch(job.inputImageUrl);
		if (!imageResponse.ok) {
			throw new Error(`Failed to download input image: ${imageResponse.status}`);
		}
		const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

		// Upload image to ComfyUI
		await db.update(rotationJob)
			.set({ currentStage: 'Uploading to ComfyUI...', progress: 5 })
			.where(eq(rotationJob.id, job.id));

		const inputFilename = await client.uploadImage(imageBuffer, `input_${job.id}.png`);
		console.log(`${logPrefix} Uploaded input image as: ${inputFilename}`);

		const workflow = JSON.parse(JSON.stringify(workflows.rotate)) as ComfyUIWorkflow;

		// Set input image (node 134) and seeds (nodes 104 and 165)
		if (workflow['134']?.inputs) workflow['134'].inputs.image = inputFilename;
		if (workflow['104']?.inputs) workflow['104'].inputs.seed = Math.floor(Math.random() * 2 ** 31);
		if (workflow['165']?.inputs) workflow['165'].inputs.seed = Math.floor(Math.random() * 2 ** 31);

		await db.update(rotationJob)
			.set({ currentStage: 'Generating rotations with SV3D...', progress: 10 })
			.where(eq(rotationJob.id, job.id));

		const promptId = await client.queuePrompt(workflow, async (info) => {
			// Scale progress: 10-90% for generation
			const scaledProgress = 10 + Math.floor(info.progress * 0.8);
			console.log(`${logPrefix} ${scaledProgress}% - ${info.stage}`);
			await db.update(rotationJob)
				.set({ progress: scaledProgress, currentStage: formatProgress(info) })
				.where(eq(rotationJob.id, job.id));
		});

		const outputs = await client.waitForCompletion(promptId, 900000); // 15 min timeout for SV3D

		await db.update(rotationJob)
			.set({ progress: 92, currentStage: 'Uploading images...' })
			.where(eq(rotationJob.id, job.id));

		// Find output from node 129 (SaveImage with all 8 directions)
		const uploadedUrls: Record<string, string> = {};
		const outputNode = outputs['129'] as { images?: Array<{ filename: string; subfolder: string; type: string }> } | undefined;

		if (outputNode?.images?.length) {
			// The output contains 8 images in batch order
			for (let i = 0; i < Math.min(outputNode.images.length, 8); i++) {
				const img = outputNode.images[i];
				const direction = ROTATION_DIRECTIONS[i];
				const imageData = await client.getImage(img.filename, img.subfolder, img.type);
				uploadedUrls[direction] = await uploadToBlob(imageData, `rotations/${job.id}_${direction}.png`);
				console.log(`${logPrefix} Uploaded ${direction.toUpperCase()}`);
			}
		} else {
			throw new Error('No output images generated from workflow');
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

		// Set prompt (node 45)
		if (workflow['45']?.inputs) {
			workflow['45'].inputs.text = job.prompt;
		}

		// Set dimensions (node 40)
		if (workflow['40']?.inputs) {
			workflow['40'].inputs.width = job.width;
			workflow['40'].inputs.height = job.height;
		}

		// Set seed (node 41)
		if (workflow['41']?.inputs) {
			workflow['41'].inputs.noise_seed = Math.floor(Math.random() * 2 ** 31);
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

		// Find output image from save_image node
		let imageUrl: string | null = null;
		const saveImageOutput = outputs['save_image'] as { images?: Array<{ filename: string; subfolder: string; type: string }> } | undefined;

		if (saveImageOutput?.images?.length) {
			const img = saveImageOutput.images[0];
			const imageData = await client.getImage(img.filename, img.subfolder, img.type);
			imageUrl = await uploadToBlob(imageData, `assets/${job.id}.png`);
		} else {
			// Fallback: search all outputs
			for (const output of Object.values(outputs)) {
				const outputData = output as { images?: Array<{ filename: string; subfolder: string; type: string }> };
				if (outputData.images?.length) {
					const img = outputData.images[0];
					const imageData = await client.getImage(img.filename, img.subfolder, img.type);
					imageUrl = await uploadToBlob(imageData, `assets/${job.id}.png`);
					break;
				}
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

// Texture output node mapping
const TEXTURE_OUTPUT_NODES: Record<string, string> = {
	'9': 'basecolor',
	'14': 'normal',
	'16': 'height',
	'17': 'roughness',
	'18': 'metallic',
};

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

		const workflow = JSON.parse(JSON.stringify(workflows.texture)) as ComfyUIWorkflow;

		// Build the full prompt with texture-specific suffix
		const fullPrompt = `${job.prompt}, seamless tileable texture, top-down flat view, no shadows, texture map`;

		// Set prompts (nodes 62 and 65 are positive prompts for base and refiner)
		if (workflow['62']?.inputs) workflow['62'].inputs.text = fullPrompt;
		if (workflow['65']?.inputs) workflow['65'].inputs.text = fullPrompt;

		// Set seed (node 64 is KSamplerAdvanced for base)
		const seed = Math.floor(Math.random() * 2 ** 31);
		if (workflow['64']?.inputs) workflow['64'].inputs.noise_seed = seed;

		console.log(`${logPrefix} Prompt: "${job.prompt?.substring(0, 50)}..."`);

		const promptId = await client.queuePrompt(workflow, async (info) => {
			console.log(`${logPrefix} ${info.progress}% - ${info.stage}`);
			await db.update(textureGeneration)
				.set({ progress: info.progress, currentStage: formatProgress(info) })
				.where(eq(textureGeneration.id, job.id));
		});

		const outputs = await client.waitForCompletion(promptId, 600000);

		await db.update(textureGeneration)
			.set({ progress: 95, currentStage: 'Uploading textures...' })
			.where(eq(textureGeneration.id, job.id));

		// Extract and upload all PBR maps
		const uploadedUrls: Record<string, string> = {};
		for (const [nodeId, output] of Object.entries(outputs)) {
			const mapType = TEXTURE_OUTPUT_NODES[nodeId];
			const outputData = output as { images?: Array<{ filename: string; subfolder: string; type: string }> };

			if (mapType && outputData.images?.length) {
				const img = outputData.images[0];
				const imageData = await client.getImage(img.filename, img.subfolder, img.type);
				uploadedUrls[mapType] = await uploadToBlob(imageData, `textures/${job.id}_${mapType}.png`);
				console.log(`${logPrefix} Uploaded ${mapType}`);
			}
		}

		// Verify we got all maps
		const requiredMaps = ['basecolor', 'normal', 'height', 'roughness', 'metallic'];
		const missingMaps = requiredMaps.filter(m => !uploadedUrls[m]);
		if (missingMaps.length > 0) {
			throw new Error(`Missing texture maps: ${missingMaps.join(', ')}`);
		}

		await db.update(textureGeneration)
			.set({
				status: 'completed',
				progress: 100,
				currentStage: 'Complete',
				basecolorUrl: uploadedUrls.basecolor,
				normalUrl: uploadedUrls.normal,
				heightUrl: uploadedUrls.height,
				roughnessUrl: uploadedUrls.roughness,
				metallicUrl: uploadedUrls.metallic,
				seed,
				completedAt: new Date(),
			})
			.where(eq(textureGeneration.id, job.id));

		console.log(`${logPrefix} Completed`);
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
