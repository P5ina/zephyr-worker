import WebSocket from 'ws';
import { nanoid } from 'nanoid';

const COMFYUI_URL = process.env.COMFYUI_URL || 'http://127.0.0.1:8188';
const COMFYUI_WS_URL = COMFYUI_URL.replace('https://', 'wss://').replace('http://', 'ws://');

export interface ProgressInfo {
	progress: number;
	stage: string;
	elapsedSeconds: number;
	estimatedTotalSeconds: number;
	estimatedRemainingSeconds: number;
}

export interface ProgressCallback {
	(info: ProgressInfo): void;
}

export interface ComfyUIWorkflow {
	[nodeId: string]: {
		class_type: string;
		inputs: Record<string, unknown>;
	};
}

// Human-readable stage names for node types
const NODE_STAGES: Record<string, string> = {
	'UNETLoader': 'Loading Flux model',
	'DualCLIPLoader': 'Loading CLIP',
	'VAELoader': 'Loading VAE',
	'CLIPTextEncode': 'Encoding prompt',
	'KSampler': 'Generating image',
	'VAEDecode': 'Decoding image',
	'RMBG': 'Removing background',
	'LoadTripoSRModel': 'Loading TripoSR',
	'ImageTo3DMesh': 'Creating 3D mesh',
	'RenderMesh8Directions': 'Rendering 8 directions',
	'ControlNetLoader': 'Loading ControlNet',
	'ControlNetApplyAdvanced': 'Applying ControlNet',
	'Canny': 'Detecting edges',
	'SaveImage': 'Saving image',
	// SV3D workflow
	'SV3D_Conditioning': 'Preparing SV3D conditioning',
	'CLIPVisionLoader': 'Loading CLIP Vision',
	'CheckpointLoaderSimple': 'Loading model',
	'ImageFromBatch': 'Extracting frame',
	'BatchImagesNode': 'Batching images',
	'ImageUpscaleWithModel': 'Upscaling images',
	'UpscaleModelLoader': 'Loading upscale model',
	'ImageScale': 'Scaling images',
	'IPAdapterModelLoader': 'Loading IPAdapter',
	'IPAdapterAdvanced': 'Applying IPAdapter',
	'PrepImageForClipVision': 'Preparing for CLIP Vision',
	'LoadImage': 'Loading input image',
	// Flux workflow nodes
	'SamplerCustomAdvanced': 'Generating image',
	'RandomNoise': 'Generating noise',
	'KSamplerSelect': 'Selecting sampler',
	'BasicScheduler': 'Setting up scheduler',
	'BasicGuider': 'Setting up guidance',
};

// Approximate execution time weights for node types (relative)
const NODE_WEIGHTS: Record<string, number> = {
	'KSampler': 30,           // Main generation - heaviest
	'ImageTo3DMesh': 20,      // 3D mesh generation
	'RenderMesh8Directions': 15,
	'SV3D_Conditioning': 5,   // SV3D prep
	'ImageUpscaleWithModel': 10, // Upscaling is heavy
	'IPAdapterAdvanced': 5,
	'RMBG': 5,
	'VAEDecode': 3,
	'VAEEncode': 2,
	'UNETLoader': 2,
	'LoadTripoSRModel': 2,
	'CheckpointLoaderSimple': 3,
	'UpscaleModelLoader': 2,
	'IPAdapterModelLoader': 2,
	'ControlNetLoader': 1,
	'DualCLIPLoader': 1,
	'VAELoader': 1,
	'CLIPTextEncode': 1,
	'CLIPVisionLoader': 1,
	'Canny': 1,
	'SaveImage': 1,
	'PreviewImage': 1,
	'ImageFromBatch': 1,
	'BatchImagesNode': 1,
	'ImageScale': 1,
	'PrepImageForClipVision': 1,
	'LoadImage': 1,
	// Flux workflow nodes
	'SamplerCustomAdvanced': 30,  // Main generation
	'RandomNoise': 1,
	'KSamplerSelect': 1,
	'BasicScheduler': 1,
	'BasicGuider': 1,
};

export class ComfyUIClient {
	private ws: WebSocket | null = null;
	private clientId: string;
	private promptId: string | null = null;
	private onProgress: ProgressCallback | null = null;
	private workflow: ComfyUIWorkflow | null = null;
	private executedNodes: Set<string> = new Set();
	private totalNodes: number = 0;
	private totalWeight: number = 0;
	private completedWeight: number = 0;
	private maxProgress: number = 0;  // Never go below this
	private startTime: number = 0;

	constructor() {
		this.clientId = nanoid();
	}

	private getNodeWeight(nodeId: string): number {
		const classType = this.getNodeClassType(nodeId);
		return NODE_WEIGHTS[classType] || 1;
	}

	async connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const wsUrl = `${COMFYUI_WS_URL}/ws?clientId=${this.clientId}`;
			console.log(`[ComfyUI] Connecting to WebSocket: ${wsUrl}`);

			this.ws = new WebSocket(wsUrl);

			this.ws.on('open', () => {
				console.log('[ComfyUI] WebSocket connected');
				resolve();
			});

			this.ws.on('error', (err) => {
				console.error('[ComfyUI] WebSocket error:', err.message);
				reject(err);
			});

			this.ws.on('close', () => {
				console.log('[ComfyUI] WebSocket closed');
				this.ws = null;
			});

			this.ws.on('message', (data) => {
				this.handleMessage(data.toString());
			});
		});
	}

	disconnect(): void {
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}

	private getNodeClassType(nodeId: string): string {
		if (!this.workflow) return '';
		// Handle composite node IDs like "74:62"
		const baseId = nodeId.split(':')[0];
		return this.workflow[baseId]?.class_type || '';
	}

	private handleMessage(data: string): void {
		try {
			const msg = JSON.parse(data);
			const { type, data: payload } = msg;

			switch (type) {
				case 'execution_start':
					if (payload.prompt_id === this.promptId) {
						console.log(`[ComfyUI] Execution started`);
						this.executedNodes.clear();
						this.completedWeight = 0;
						this.maxProgress = 0;
						this.reportProgress(0, 'Starting...');
					}
					break;

				case 'execution_cached':
					if (payload.prompt_id === this.promptId && payload.nodes) {
						for (const nodeId of payload.nodes) {
							const baseId = nodeId.split(':')[0];
							if (!this.executedNodes.has(baseId)) {
								this.executedNodes.add(baseId);
								this.completedWeight += this.getNodeWeight(baseId);
							}
						}
						this.updateProgress();
					}
					break;

				case 'executing':
					if (payload.prompt_id === this.promptId && payload.node === null) {
						console.log('[ComfyUI] Execution complete');
						this.reportProgress(100, 'Complete');
					}
					break;

				case 'executed':
					if (payload.prompt_id === this.promptId && payload.node) {
						const baseId = payload.node.split(':')[0];
						if (!this.executedNodes.has(baseId)) {
							this.executedNodes.add(baseId);
							this.completedWeight += this.getNodeWeight(baseId);
						}
						this.updateProgress(baseId);
					}
					break;

				case 'progress':
					if (payload.prompt_id === this.promptId) {
						// KSampler progress - use weighted calculation
						const kSamplerWeight = NODE_WEIGHTS['KSampler'] || 30;
						const stepFraction = payload.value / payload.max;
						const currentStepWeight = kSamplerWeight * stepFraction;
						const totalProgress = this.totalWeight > 0
							? ((this.completedWeight + currentStepWeight) / this.totalWeight) * 100
							: ((this.executedNodes.size / this.totalNodes) * 100);
						const progress = Math.min(99, Math.round(totalProgress));
						this.reportProgress(progress, `Generating (step ${payload.value}/${payload.max})`);
					}
					break;

				case 'execution_error':
					if (payload.prompt_id === this.promptId) {
						console.error('[ComfyUI] Execution error:', payload.exception_message);
					}
					break;
			}
		} catch {
			// Ignore parse errors for binary messages
		}
	}

	private updateProgress(lastNodeId?: string): void {
		// Use weighted progress for more accurate estimates
		const progress = this.totalWeight > 0
			? Math.min(99, Math.round((this.completedWeight / this.totalWeight) * 100))
			: Math.min(99, Math.round((this.executedNodes.size / this.totalNodes) * 100));
		let stage = 'Processing...';

		if (lastNodeId) {
			const classType = this.getNodeClassType(lastNodeId);
			stage = NODE_STAGES[classType] || classType || 'Processing...';
		}

		this.reportProgress(progress, stage);
	}

	private reportProgress(progress: number, stage: string): void {
		if (this.onProgress) {
			// Never let progress go backwards
			if (progress > this.maxProgress) {
				this.maxProgress = progress;
			}
			const finalProgress = Math.max(progress, this.maxProgress);

			const elapsedSeconds = Math.round((Date.now() - this.startTime) / 1000);
			let estimatedTotalSeconds = 0;
			let estimatedRemainingSeconds = 0;

			if (finalProgress > 0 && finalProgress < 100) {
				estimatedTotalSeconds = Math.round((elapsedSeconds / finalProgress) * 100);
				estimatedRemainingSeconds = Math.max(0, estimatedTotalSeconds - elapsedSeconds);
			}

			this.onProgress({
				progress: finalProgress,
				stage,
				elapsedSeconds,
				estimatedTotalSeconds,
				estimatedRemainingSeconds,
			});
		}
	}

	async queuePrompt(workflow: ComfyUIWorkflow, onProgress?: ProgressCallback): Promise<string> {
		this.workflow = workflow;
		this.onProgress = onProgress || null;
		this.executedNodes.clear();
		this.totalNodes = Object.keys(workflow).length;
		this.completedWeight = 0;
		this.maxProgress = 0;
		this.startTime = Date.now();

		// Calculate total weight for weighted progress
		this.totalWeight = 0;
		for (const nodeId of Object.keys(workflow)) {
			this.totalWeight += this.getNodeWeight(nodeId);
		}

		console.log(`[ComfyUI] Total nodes: ${this.totalNodes}, total weight: ${this.totalWeight}`);

		const response = await fetch(`${COMFYUI_URL}/prompt`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				prompt: workflow,
				client_id: this.clientId,
			}),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Failed to queue prompt: ${response.status} - ${text}`);
		}

		const result = await response.json() as { prompt_id: string };
		this.promptId = result.prompt_id;
		console.log(`[ComfyUI] Queued prompt: ${this.promptId}`);

		return this.promptId;
	}

	async waitForCompletion(promptId: string, timeout: number = 600000): Promise<Record<string, unknown>> {
		const start = Date.now();

		while (Date.now() - start < timeout) {
			const response = await fetch(`${COMFYUI_URL}/history/${promptId}`);
			if (response.ok) {
				const history = await response.json() as Record<string, { status?: { completed: boolean; status_str: string }; outputs: Record<string, unknown> }>;
				const entry = history[promptId];

				if (entry?.status?.status_str === 'error') {
					throw new Error('Workflow execution failed');
				}

				if (entry?.status?.completed) {
					return entry.outputs;
				}
			}

			await new Promise((resolve) => setTimeout(resolve, 1000));
		}

		throw new Error(`Timeout waiting for completion after ${timeout / 1000}s`);
	}

	async getImage(filename: string, subfolder: string = '', type: string = 'output'): Promise<Buffer> {
		const params = new URLSearchParams({ filename, subfolder, type });
		const response = await fetch(`${COMFYUI_URL}/view?${params}`);

		if (!response.ok) {
			throw new Error(`Failed to fetch image: ${response.status}`);
		}

		const arrayBuffer = await response.arrayBuffer();
		return Buffer.from(arrayBuffer);
	}

	async uploadImage(imageData: Buffer, filename: string): Promise<string> {
		const formData = new FormData();
		formData.append('image', new Blob([imageData], { type: 'image/png' }), filename);
		formData.append('overwrite', 'true');

		const response = await fetch(`${COMFYUI_URL}/upload/image`, {
			method: 'POST',
			body: formData,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Failed to upload image: ${response.status} - ${text}`);
		}

		const result = await response.json() as { name: string; subfolder: string; type: string };
		return result.name;
	}

	async checkHealth(): Promise<boolean> {
		try {
			const response = await fetch(`${COMFYUI_URL}/system_stats`);
			return response.ok;
		} catch {
			return false;
		}
	}
}
