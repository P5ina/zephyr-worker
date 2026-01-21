import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { pgTable, text, integer, timestamp, json } from 'drizzle-orm/pg-core';

// User table
export const user = pgTable('user', {
	id: text('id').primaryKey(),
	tokens: integer('tokens').notNull().default(25),
	bonusTokens: integer('bonus_tokens').notNull().default(0),
});

// Rotation jobs
export const rotationJob = pgTable('rotation_job', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull(),
	status: text('status', {
		enum: ['pending', 'processing', 'completed', 'failed'],
	}).notNull().default('pending'),
	progress: integer('progress').notNull().default(0),
	currentStage: text('current_stage'),
	startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
	prompt: text('prompt'),
	mode: text('mode', { enum: ['regular', 'pixel_art'] }).notNull().default('regular'),
	pixelResolution: integer('pixel_resolution'),
	colorCount: integer('color_count'),
	rotationN: text('rotation_n'),
	rotationNE: text('rotation_ne'),
	rotationE: text('rotation_e'),
	rotationSE: text('rotation_se'),
	rotationS: text('rotation_s'),
	rotationSW: text('rotation_sw'),
	rotationW: text('rotation_w'),
	rotationNW: text('rotation_nw'),
	tokenCost: integer('token_cost').notNull(),
	errorMessage: text('error_message'),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
	completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
});

// Asset generation (sprites, pixel art)
export const assetGeneration = pgTable('asset_generation', {
	id: text('id').primaryKey(),
	visibleId: text('visible_id').notNull(),
	userId: text('user_id').notNull(),
	assetType: text('asset_type', { enum: ['sprite', 'pixel_art', 'texture'] }).notNull(),
	prompt: text('prompt').notNull(),
	negativePrompt: text('negative_prompt'),
	width: integer('width').notNull().default(512),
	height: integer('height').notNull().default(512),
	status: text('status', {
		enum: ['pending', 'queued', 'processing', 'post_processing', 'completed', 'failed'],
	}).notNull().default('pending'),
	progress: integer('progress').notNull().default(0),
	currentStage: text('current_stage'),
	resultUrls: json('result_urls').$type<{ raw?: string; processed?: string; thumbnail?: string }>(),
	seed: integer('seed'),
	tokenCost: integer('token_cost').notNull(),
	errorMessage: text('error_message'),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
	completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
});

// Texture generation (PBR maps)
export const textureGeneration = pgTable('texture_generation', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull(),
	prompt: text('prompt').notNull(),
	status: text('status', {
		enum: ['pending', 'processing', 'completed', 'failed'],
	}).notNull().default('pending'),
	progress: integer('progress').notNull().default(0),
	currentStage: text('current_stage'),
	basecolorUrl: text('basecolor_url'),
	normalUrl: text('normal_url'),
	roughnessUrl: text('roughness_url'),
	metallicUrl: text('metallic_url'),
	heightUrl: text('height_url'),
	seed: integer('seed'),
	tokenCost: integer('token_cost').notNull(),
	errorMessage: text('error_message'),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
	completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
});

// Database connection
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (!DATABASE_URL) {
	throw new Error('DATABASE_URL or POSTGRES_URL environment variable is required');
}

const client = postgres(DATABASE_URL);
export const db = drizzle(client, { schema: { user, rotationJob, assetGeneration, textureGeneration } });

export type RotationJob = typeof rotationJob.$inferSelect;
export type AssetGeneration = typeof assetGeneration.$inferSelect;
export type TextureGeneration = typeof textureGeneration.$inferSelect;
