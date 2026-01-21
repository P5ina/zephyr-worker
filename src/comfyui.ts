import WebSocket from 'ws';
import { nanoid } from 'nanoid';

const COMFYUI_URL = process.env.COMFYUI_URL || 'http://127.0.0.1:8188';
const COMFYUI_WS_URL = COMFYUI_URL.replace('https://', 'wss://').replace('http://', 'ws://');

export interface ProgressCallback {
	(progress: number, stage: string, nodeId?: string): void;
}

export interface ComfyUIWorkflow {
	[nodeId: string]: {
		class_type: string;
		inputs: Record<string, unknown>;
	};
}

// Node class types mapped to human-readable stage names
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
};

// Estimate progress based on node execution order
const NODE_WEIGHTS: Record<string, number> = {
	'UNETLoader': 5,
	'DualCLIPLoader': 2,
	'VAELoader': 1,
	'CLIPTextEncode': 1,
	'EmptyLatentImage': 1,
	'FluxGuidance': 1,
	'KSampler': 15, // Heavy - image generation
	'VAEDecode': 2,
	'RMBG': 5,
	'LoadTripoSRModel': 5,
	'ImageTo3DMesh': 25, // Heavy - 3D reconstruction
	'RenderMesh8Directions': 10,
	'ControlNetLoader': 2,
	'ControlNetApplyAdvanced': 3,
	'Canny': 2,
	'VAEEncode': 2,
	'SaveImage': 1,
};

export class ComfyUIClient {
	private ws: WebSocket | null = null;
	private clientId: string;
	private promptId: string | null = null;
	private onProgress: ProgressCallback | null = null;
	private executedNodes: Set<string> = new Set();
	private totalWeight: number = 0;
	private executedWeight: number = 0;
	private currentNodeType: string = '';
	private samplerProgress: number = 0;
	private samplerMax: number = 0;

	constructor() {
		this.clientId = nanoid();
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

	private handleMessage(data: string): void {
		try {
			const msg = JSON.parse(data);
			const { type, data: payload } = msg;

			switch (type) {
				case 'status':
					// Queue status update
					break;

				case 'execution_start':
					if (payload.prompt_id === this.promptId) {
						console.log(`[ComfyUI] Execution started: ${this.promptId}`);
						this.executedNodes.clear();
						this.executedWeight = 0;
						this.reportProgress('Starting...');
					}
					break;

				case 'execution_cached':
					// Nodes that were cached (already computed)
					if (payload.prompt_id === this.promptId && payload.nodes) {
						for (const nodeId of payload.nodes) {
							this.executedNodes.add(nodeId);
						}
					}
					break;

				case 'executing':
					if (payload.prompt_id === this.promptId) {
						if (payload.node === null) {
							// Execution complete
							console.log('[ComfyUI] Execution complete');
							this.reportProgress('Complete', 100);
						} else {
							// New node executing
							this.currentNodeType = '';
							this.samplerProgress = 0;
							this.samplerMax = 0;
						}
					}
					break;

				case 'executed':
					if (payload.prompt_id === this.promptId && payload.node) {
						this.executedNodes.add(payload.node);
						const nodeType = payload.output?.class_type || this.currentNodeType;
						const weight = NODE_WEIGHTS[nodeType] || 1;
						this.executedWeight += weight;
						const progress = Math.min(99, Math.round((this.executedWeight / this.totalWeight) * 100));
						const stage = NODE_STAGES[nodeType] || nodeType || 'Processing';
						console.log(`[ComfyUI] Node executed: ${payload.node} (${nodeType}) - ${progress}%`);
						this.reportProgress(stage, progress);
					}
					break;

				case 'progress':
					// Sampler step progress
					if (payload.prompt_id === this.promptId) {
						this.samplerProgress = payload.value;
						this.samplerMax = payload.max;
						const stepInfo = `Step ${payload.value}/${payload.max}`;
						const baseProgress = Math.round((this.executedWeight / this.totalWeight) * 100);
						const stepProgress = (payload.value / payload.max) * (NODE_WEIGHTS['KSampler'] / this.totalWeight) * 100;
						const progress = Math.min(99, Math.round(baseProgress + stepProgress));
						this.reportProgress(`Generating image (${stepInfo})`, progress);
					}
					break;

				case 'execution_error':
					if (payload.prompt_id === this.promptId) {
						console.error('[ComfyUI] Execution error:', payload.exception_message);
					}
					break;
			}
		} catch (err) {
			// Ignore parse errors for binary messages
		}
	}

	private reportProgress(stage: string, progress?: number): void {
		if (this.onProgress) {
			const p = progress ?? Math.min(99, Math.round((this.executedWeight / this.totalWeight) * 100));
			this.onProgress(p, stage);
		}
	}

	async queuePrompt(workflow: ComfyUIWorkflow, onProgress?: ProgressCallback): Promise<string> {
		this.onProgress = onProgress || null;
		this.executedNodes.clear();
		this.executedWeight = 0;

		// Calculate total weight from workflow
		this.totalWeight = 0;
		for (const node of Object.values(workflow)) {
			const weight = NODE_WEIGHTS[node.class_type] || 1;
			this.totalWeight += weight;
		}
		console.log(`[ComfyUI] Total workflow weight: ${this.totalWeight}`);

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

	async checkHealth(): Promise<boolean> {
		try {
			const response = await fetch(`${COMFYUI_URL}/system_stats`);
			return response.ok;
		} catch {
			return false;
		}
	}
}
