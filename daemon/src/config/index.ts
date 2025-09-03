/**
 * Centralized configuration management with validation
 */
import path from 'path';
import type { ServerConfig, AIConfig, AudioConfig, CacheConfig } from '../types/index.js';

/**
 * Validates required environment variables
 */
function validateRequired(value: string | undefined, name: string): string {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

/**
 * Safely parses numeric environment variables
 */
function parseNumber(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Safely parses boolean environment variables
 */
function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  return value.toLowerCase().trim() === 'true';
}

/**
 * Server configuration
 */
export const serverConfig: ServerConfig = {
  port: parseNumber(process.env.PORT, 17321),
  toolSecret: process.env.TOOL_SECRET,
} as const;

/**
 * AI service configuration
 */
export const aiConfig: AIConfig = {
  embeddingModel: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
  chatModel: process.env.CHAT_MODEL ?? 'gpt-4o-mini',
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM',
  elevenLabsAgentId: process.env.ELEVENLABS_AGENT_ID,
  tavilyApiKey: process.env.TAVILY_API_KEY,
  openAiApiKey: process.env.OPENAI_API_KEY,
} as const;

/**
 * Audio processing configuration
 */
export const audioConfig: AudioConfig = {
  enableAudio: parseBoolean(process.env.ENABLE_AUDIO, false),
  wakeKeyword: process.env.WAKE_KEYWORD ?? 'Jarvis',
  sensitivity: Math.max(0, Math.min(1, parseNumber(process.env.SENSITIVITY, 0.6))),
  pvAccessKey: process.env.PV_ACCESS_KEY,
} as const;

/**
 * Cache configuration
 */
export const cacheConfig: CacheConfig = {
  transcriptDir: path.join(process.cwd(), 'cache', 'transcripts'),
  mediaDir: path.join(process.cwd(), 'cache', 'agent_media'),
} as const;

/**
 * Validates critical configuration on startup
 */
export function validateConfig(): void {
  const errors: string[] = [];

  // Validate OpenAI API key if needed
  if (!aiConfig.openAiApiKey) {
    console.warn('⚠️  OPENAI_API_KEY not set - transcription and embeddings will be disabled');
  }

  // Validate ElevenLabs config if agent features are used
  if (!aiConfig.elevenLabsApiKey) {
    console.warn('⚠️  ELEVENLABS_API_KEY not set - TTS and conversational AI will be disabled');
  }

  if (!aiConfig.elevenLabsAgentId && aiConfig.elevenLabsApiKey) {
    console.warn('⚠️  ELEVENLABS_AGENT_ID not set - conversational AI will use fallback mode');
  }

  // Validate audio config if enabled
  if (audioConfig.enableAudio && !audioConfig.pvAccessKey) {
    errors.push('ENABLE_AUDIO is true but PV_ACCESS_KEY is not set');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
  }

  console.log('✅ Configuration validated successfully');
}

/**
 * Logs current configuration (without secrets)
 */
export function logConfig(): void {
  console.log('📋 Current Configuration:');
  console.log(`  Server Port: ${serverConfig.port}`);
  console.log(`  Audio Enabled: ${audioConfig.enableAudio}`);
  console.log(`  Wake Keyword: ${audioConfig.wakeKeyword}`);
  console.log(`  Embedding Model: ${aiConfig.embeddingModel}`);
  console.log(`  Chat Model: ${aiConfig.chatModel}`);
  console.log(`  ElevenLabs Voice: ${aiConfig.elevenLabsVoiceId}`);
  console.log(`  Cache Dir: ${cacheConfig.transcriptDir}`);
}