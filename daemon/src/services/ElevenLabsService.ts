/**
 * Service for ElevenLabs TTS and Conversational AI
 */
import WebSocket from 'ws';
import fs from 'fs';
import type { ConversationalSession, SessionMemoryItem } from '../types/index.js';
import { CacheService } from './CacheService.js';
import { aiConfig } from '../config/index.js';

export class ElevenLabsService {
  private static sessions = new Map<string, ConversationalSession>();
  private static sessionMemory = new Map<string, SessionMemoryItem[]>();

  /**
   * Generates speech from text using ElevenLabs TTS
   */
  static async textToSpeech(text: string): Promise<string | null> {
    if (!aiConfig.elevenLabsApiKey) {
      console.warn('[ElevenLabsService] API key not available for TTS');
      return null;
    }

    try {
      const filename = `ans-${Date.now()}.mp3`;
      const outputPath = CacheService.mediaPath(filename);

      console.log(`[ElevenLabsService] Generating TTS for: "${text.substring(0, 50)}..."`);

      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${aiConfig.elevenLabsVoiceId}/stream`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': aiConfig.elevenLabsApiKey,
            'Accept': 'audio/mpeg'
          },
          body: JSON.stringify({
            text,
            model_id: 'eleven_multilingual_v2',
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75
            }
          })
        }
      );

      if (!response.ok) {
        throw new Error(`ElevenLabs TTS API responded with status ${response.status}`);
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      CacheService.ensureDirectories();
      fs.writeFileSync(outputPath, audioBuffer);

      console.log(`[ElevenLabsService] TTS generated successfully: ${filename}`);
      return `/media/${filename}`;

    } catch (error) {
      console.error('[ElevenLabsService] TTS generation failed:', (error as Error).message);
      return null;
    }
  }

  /**
   * Gets or creates a conversational session
   */
  static async getConversationalSession(sessionId: string): Promise<ConversationalSession | null> {
    if (!aiConfig.elevenLabsApiKey || !aiConfig.elevenLabsAgentId) {
      console.warn('[ElevenLabsService] Missing API key or agent ID for conversational AI');
      return null;
    }

    // Return existing session if available and connected
    const existing = this.sessions.get(sessionId);
    if (existing && existing.ws.readyState === 1) {
      return existing;
    }

    // Create new session
    return await this.createConversationalSession(sessionId);
  }

  /**
   * Creates a new conversational WebSocket session
   */
  private static async createConversationalSession(sessionId: string): Promise<ConversationalSession | null> {
    try {
      console.log(`[ElevenLabsService] Creating conversational session: ${sessionId}`);

      // Get signed WebSocket URL
      const wsUrl = await this.getSignedWebSocketUrl();
      if (!wsUrl) {
        console.error('[ElevenLabsService] Failed to get signed WebSocket URL');
        return null;
      }

      // Create WebSocket connection
      const ws = new WebSocket(wsUrl, {
        headers: {
          'xi-api-key': aiConfig.elevenLabsApiKey!
        }
      });

      // Initialize session object
      const session: ConversationalSession = {
        ws,
        isOpen: false,
        sentInit: false,
        lastAudioAt: 0,
        lastEventAt: Date.now(),
        turnChunks: [],
        agentText: '',
        seenResponse: false,
        finalReady: false,
        pending: [],
        interval: null
      };

      // Store session
      this.sessions.set(sessionId, session);

      // Set up WebSocket event handlers
      this.setupWebSocketHandlers(sessionId, session);

      return session;

    } catch (error) {
      console.error('[ElevenLabsService] Failed to create conversational session:', (error as Error).message);
      return null;
    }
  }

  /**
   * Gets signed WebSocket URL from ElevenLabs
   */
  private static async getSignedWebSocketUrl(): Promise<string | null> {
    try {
      const primaryUrl = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(aiConfig.elevenLabsAgentId!)}`;
      
      let response = await fetch(primaryUrl, {
        headers: { 'xi-api-key': aiConfig.elevenLabsApiKey! }
      });

      if (!response.ok) {
        // Try alternative URL format
        const altUrl = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(aiConfig.elevenLabsAgentId!)}`;
        response = await fetch(altUrl, {
          headers: { 'xi-api-key': aiConfig.elevenLabsApiKey! }
        });
      }

      if (!response.ok) {
        throw new Error(`Signed URL request failed with status ${response.status}`);
      }

      const data: any = await response.json();
      return data?.signed_url || null;

    } catch (error) {
      console.error('[ElevenLabsService] Failed to get signed URL:', (error as Error).message);
      return null;
    }
  }

  /**
   * Sets up WebSocket event handlers for a session
   */
  private static setupWebSocketHandlers(sessionId: string, session: ConversationalSession): void {
    const { ws } = session;

    ws.on('open', () => {
      session.isOpen = true;
      session.lastEventAt = Date.now();
      console.log(`[ElevenLabsService] Session ${sessionId} connected`);

      // Send initialization message
      try {
        const initMessage = { type: 'conversation_initiation_client_data' };
        ws.send(JSON.stringify(initMessage));
        session.sentInit = true;
      } catch (error) {
        console.error('[ElevenLabsService] Failed to send init message:', error);
      }

      // Start turn finalization checker
      session.interval = setInterval(() => this.checkTurnFinalization(sessionId), 300);
    });

    ws.on('message', (data) => {
      this.handleWebSocketMessage(sessionId, session, data);
    });

    ws.on('close', (code, reason) => {
      console.log(`[ElevenLabsService] Session ${sessionId} closed:`, code, reason?.toString());
      this.cleanupSession(sessionId);
    });

    ws.on('error', (error) => {
      console.error(`[ElevenLabsService] Session ${sessionId} error:`, error);
      this.cleanupSession(sessionId);
    });
  }

  /**
   * Handles incoming WebSocket messages
   */
  private static handleWebSocketMessage(sessionId: string, session: ConversationalSession, data: any): void {
    try {
      const message = JSON.parse(data.toString());
      session.lastEventAt = Date.now();

      const messageType = message?.type ?? '';
      console.log(`[ElevenLabsService] Session ${sessionId} received: ${messageType}`);

      switch (messageType) {
        case 'conversation_initiation_metadata':
          console.log(`[ElevenLabsService] Conversation initialized: ${message?.conversation_initiation_metadata_event?.conversation_id}`);
          break;

        case 'agent_response':
          this.handleAgentResponse(session, message);
          break;

        case 'agent_response_correction':
          this.handleAgentResponseCorrection(session, message);
          break;

        case 'audio':
          this.handleAudioChunk(session, message);
          break;

        case 'ping':
          this.handlePing(session.ws, message);
          break;

        case 'response_completed':
        case 'response_end':
        case 'done':
        case 'conversation_end':
          session.finalReady = true;
          break;

        case 'internal_tentative_agent_response':
          this.handleTentativeResponse(session, message);
          break;
      }

    } catch (error) {
      console.error(`[ElevenLabsService] Failed to parse message:`, error);
    }
  }

  /**
   * Handles agent response messages
   */
  private static handleAgentResponse(session: ConversationalSession, message: any): void {
    const responseText = String(message?.agent_response_event?.agent_response ?? '');
    if (responseText) {
      session.agentText = responseText;
      session.seenResponse = true;
      
      // Check for final flag
      if (message?.agent_response_event?.is_final === true) {
        session.finalReady = true;
      }
    }
  }

  /**
   * Handles corrected agent responses
   */
  private static handleAgentResponseCorrection(session: ConversationalSession, message: any): void {
    const correctedText = String(message?.agent_response_correction_event?.corrected_agent_response ?? '');
    if (correctedText) {
      session.agentText = correctedText;
      session.seenResponse = true;
      session.finalReady = true; // Corrections are typically final
    }
  }

  /**
   * Handles audio chunks
   */
  private static handleAudioChunk(session: ConversationalSession, message: any): void {
    const audioBase64 = String(message?.audio_event?.audio_base_64 ?? message?.audio?.chunk ?? '');
    if (audioBase64) {
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      session.turnChunks.push(audioBuffer);
      session.lastAudioAt = Date.now();
    }
  }

  /**
   * Handles ping messages
   */
  private static handlePing(ws: WebSocket, message: any): void {
    const eventId = message?.ping_event?.event_id;
    if (eventId != null) {
      try {
        ws.send(JSON.stringify({ type: 'pong', event_id: eventId }));
      } catch (error) {
        console.warn('[ElevenLabsService] Failed to send pong:', error);
      }
    }
  }

  /**
   * Handles tentative responses
   */
  private static handleTentativeResponse(session: ConversationalSession, message: any): void {
    const tentativeText = String(message?.tentative_agent_response_internal_event?.tentative_agent_response ?? '');
    if (tentativeText && !session.agentText) {
      session.agentText = tentativeText;
    }
  }

  /**
   * Checks if a conversation turn should be finalized
   */
  private static checkTurnFinalization(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.pending.length) return;

    const idle = Date.now() - session.lastEventAt;
    const audioReady = session.turnChunks.length && idle > 1200;
    const textReady = session.seenResponse && idle > 3000;

    if (session.finalReady || audioReady || textReady) {
      this.finalizeTurn(session);
    }
  }

  /**
   * Finalizes a conversation turn and returns response
   */
  private static finalizeTurn(session: ConversationalSession): void {
    const sanitizedText = this.sanitizeAgentText(session.agentText);
    let audioUrl: string | null = null;

    // Process audio chunks if available
    if (session.turnChunks.length > 0) {
      audioUrl = this.processAudioChunks(session.turnChunks);
    }

    // Reset session state
    session.agentText = '';
    session.turnChunks = [];
    session.seenResponse = false;
    session.finalReady = false;
    session.lastAudioAt = 0;
    session.lastEventAt = Date.now();

    // Resolve pending promises
    const resolver = session.pending.shift();
    if (resolver) {
      resolver({ text: sanitizedText, audioUrl });
    }
  }

  /**
   * Processes audio chunks into a WAV file
   */
  private static processAudioChunks(chunks: Buffer[]): string | null {
    try {
      const combinedBuffer = Buffer.concat(chunks);
      const wavBuffer = this.pcmToWav(combinedBuffer, 16000, 1);
      
      const filename = `ans-${Date.now()}.wav`;
      const outputPath = CacheService.mediaPath(filename);
      
      CacheService.ensureDirectories();
      fs.writeFileSync(outputPath, wavBuffer);
      
      return `/media/${filename}`;
    } catch (error) {
      console.error('[ElevenLabsService] Failed to process audio chunks:', error);
      return null;
    }
  }

  /**
   * Converts PCM audio to WAV format
   */
  private static pcmToWav(pcm: Buffer, sampleRate = 16000, channels = 1): Buffer {
    const byteRate = sampleRate * channels * 2;
    const blockAlign = channels * 2;
    const dataSize = pcm.length;
    const buffer = Buffer.alloc(44 + dataSize);

    // WAV header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // PCM chunk size
    buffer.writeUInt16LE(1, 20);  // Audio format (PCM)
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(16, 34); // Bits per sample
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    
    // Copy PCM data
    pcm.copy(buffer, 44);
    
    return buffer;
  }

  /**
   * Sanitizes agent response text by removing tool outputs and code blocks
   */
  private static sanitizeAgentText(text: string): string {
    try {
      let sanitized = String(text || '');

      // Remove fenced tool blocks
      sanitized = sanitized.replace(/```\s*tool_[a-z0-9_]+[\s\S]*?```/gi, '').trim();
      sanitized = sanitized.replace(/```[^\n`]*tool_[a-z0-9_][^\n`]*\n[\s\S]*?```/gi, '').trim();
      
      // Remove inline tool outputs
      sanitized = sanitized.replace(/tool_outputs\s*\{[\s\S]*?\}/gi, '').trim();
      
      // Remove web search calls
      sanitized = sanitized.replace(/```[\s\S]*?web_search\.search\([\s\S]*?```/gi, '').trim();
      sanitized = sanitized.replace(/print\s*\(\s*web_search\.search\([\s\S]*?\)\s*\)/gi, '').trim();
      sanitized = sanitized.replace(/web_search\.search\([\s\S]*?\)/gi, '').trim();
      
      // Filter out lines with tool references
      sanitized = sanitized
        .split('\n')
        .filter((line) => !/\btool_code\b|\btool_outputs\b|\btool_result\b/i.test(line))
        .filter((line) => line.trim() !== '```')
        .join('\n')
        .trim();
      
      // Collapse excess blank lines
      sanitized = sanitized.replace(/\n{3,}/g, '\n\n');
      
      return sanitized;
    } catch {
      return text;
    }
  }

  /**
   * Sends a message to a conversational session
   */
  static async sendConversationalMessage(
    sessionId: string,
    message: string,
    context?: string
  ): Promise<{ text: string; audioUrl: string | null }> {
    const session = await this.getConversationalSession(sessionId);
    if (!session) {
      throw new Error('Failed to create conversational session');
    }

    // Wait for connection if needed
    if (!session.isOpen) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Send context if provided
    if (context?.trim()) {
      try {
        session.ws.send(JSON.stringify({
          type: 'contextual_update',
          text: context.trim()
        }));
      } catch (error) {
        console.warn('[ElevenLabsService] Failed to send context:', error);
      }
    }

    // Send user message and await response
    return new Promise<{ text: string; audioUrl: string | null }>((resolve, reject) => {
      session.pending.push(resolve);
      
      try {
        session.ws.send(JSON.stringify({
          type: 'user_message',
          text: message
        }));
      } catch (error) {
        // Remove from pending and reject
        const index = session.pending.indexOf(resolve);
        if (index > -1) {
          session.pending.splice(index, 1);
        }
        reject(new Error(`Failed to send message: ${(error as Error).message}`));
      }
    });
  }

  /**
   * Cleans up a session
   */
  private static cleanupSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.interval) {
      clearInterval(session.interval);
    }
    this.sessions.delete(sessionId);
  }

  /**
   * Manages session memory for context
   */
  static addToSessionMemory(sessionId: string, role: 'user' | 'assistant', text: string): void {
    const memory = this.sessionMemory.get(sessionId) ?? [];
    memory.push({ role, text: text.slice(0, 800) });
    
    // Keep only last 6 messages (3 turns)
    while (memory.length > 6) {
      memory.shift();
    }
    
    this.sessionMemory.set(sessionId, memory);
  }

  /**
   * Gets session memory summary
   */
  static getSessionMemory(sessionId: string): string {
    const memory = this.sessionMemory.get(sessionId) ?? [];
    return memory
      .map(item => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.text}`)
      .join('\n');
  }
}