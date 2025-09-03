/**
 * Core type definitions for VoiceRewind daemon
 */

export interface IntentMessage {
  intent:
    | 'begin_listen'
    | 'end_listen'
    | 'rewind'
    | 'forward'
    | 'set_speed'
    | 'set_volume'
    | 'pause'
    | 'play'
    | 'jump_to_phrase'
    | 'agent_response';
  value?: number | string | { text: string; audioUrl: string };
}

export interface TranscriptSegment {
  text: string;
  start?: number;
  offset?: number;
  duration?: number;
}

export interface EmbeddingItem {
  idx: number;
  start: number;
  duration: number;
  text: string;
  embedding: number[];
}

export interface EmbeddingCache {
  model: string;
  dims: number;
  items: EmbeddingItem[];
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

export interface AgentResponse {
  text: string;
  audioUrl: string | null;
  sources?: Array<{ i: number; title: string; url: string }>;
}

export interface ConversationalSession {
  ws: WebSocket;
  isOpen: boolean;
  sentInit: boolean;
  lastAudioAt: number;
  lastEventAt: number;
  turnChunks: Buffer[];
  agentText: string;
  seenResponse: boolean;
  finalReady: boolean;
  pending: Array<(r: { text: string; audioUrl: string | null }) => void>;
  interval: NodeJS.Timeout | null;
}

export interface SessionMemoryItem {
  role: 'user' | 'assistant';
  text: string;
}

export interface CacheConfig {
  transcriptDir: string;
  mediaDir: string;
}

export interface AIConfig {
  embeddingModel: string;
  chatModel: string;
  elevenLabsApiKey?: string;
  elevenLabsVoiceId: string;
  elevenLabsAgentId?: string;
  tavilyApiKey?: string;
  openAiApiKey?: string;
}

export interface AudioConfig {
  enableAudio: boolean;
  wakeKeyword: string;
  sensitivity: number;
  pvAccessKey?: string;
}

export interface ServerConfig {
  port: number;
  toolSecret?: string;
}