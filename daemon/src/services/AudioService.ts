/**
 * Service for audio processing, wake word detection, and voice recognition
 */
import OpenAI from 'openai';
import type { IntentMessage } from '../types/index.js';
import { aiConfig, audioConfig } from '../config/index.js';

export class AudioService {
  private static openai: OpenAI | null = null;

  /**
   * Gets OpenAI client for transcription
   */
  private static getOpenAIClient(): OpenAI | null {
    if (!aiConfig.openAiApiKey) {
      return null;
    }

    if (!this.openai) {
      this.openai = new OpenAI({ apiKey: aiConfig.openAiApiKey });
    }

    return this.openai;
  }

  /**
   * Initializes audio pipeline with wake word detection
   */
  static async initializeAudioPipeline(onWakeWord: (intent: IntentMessage | null, text: string) => void): Promise<void> {
    if (!audioConfig.enableAudio) {
      console.log('[AudioService] Audio pipeline disabled (set ENABLE_AUDIO=true to enable)');
      return;
    }

    if (!audioConfig.pvAccessKey) {
      console.warn('[AudioService] PV_ACCESS_KEY required for wake word detection');
      return;
    }

    try {
      // Import optional audio dependencies
      const { Porcupine, BuiltinKeyword } = await import('@picovoice/porcupine-node');
      const mic = (await import('mic')).default ?? (await import('mic'));

      console.log(`[AudioService] Initializing wake word detection for "${audioConfig.wakeKeyword}" (sensitivity: ${audioConfig.sensitivity})`);

      // Initialize wake word detector
      const detector = this.createWakeWordDetector(Porcupine, BuiltinKeyword);
      
      // Initialize microphone
      const micInstance = mic({
        rate: '16000',
        channels: '1',
        bitwidth: '16',
        encoding: 'signed-integer',
        device: 'default'
      });

      const micStream = micInstance.getAudioStream();

      // Set up audio processing
      this.setupAudioProcessing(micStream, detector, onWakeWord);

      // Start microphone
      micInstance.start();
      console.log('[AudioService] Audio pipeline started - say the wake word to begin');

    } catch (error) {
      console.warn('[AudioService] Audio pipeline initialization failed:', (error as Error).message);
      console.warn('[AudioService] Install @picovoice/porcupine-node and mic packages to enable audio features');
    }
  }

  /**
   * Creates wake word detector instance
   */
  private static createWakeWordDetector(Porcupine: any, BuiltinKeyword: any): any {
    if (audioConfig.wakeKeyword.toLowerCase().endsWith('.ppn')) {
      // Custom wake word file
      return new Porcupine(audioConfig.pvAccessKey, [audioConfig.wakeKeyword], [audioConfig.sensitivity]);
    } else {
      // Built-in wake word
      const keywordName = audioConfig.wakeKeyword.toUpperCase().replace(/\s+/g, '_');
      const builtin = BuiltinKeyword[keywordName] ?? BuiltinKeyword.PORCUPINE;
      return new Porcupine(audioConfig.pvAccessKey, [builtin], [audioConfig.sensitivity]);
    }
  }

  /**
   * Sets up audio processing pipeline
   */
  private static setupAudioProcessing(
    micStream: NodeJS.ReadableStream,
    detector: any,
    onWakeWord: (intent: IntentMessage | null, text: string) => void
  ): void {
    let frameBuffer = Buffer.alloc(0);
    const frameBytes = detector.frameLength * 2; // 16-bit PCM
    let audioChunkCount = 0;

    micStream.on('data', (data: Buffer) => {
      audioChunkCount++;
      
      // Log progress every 100 chunks to show the system is active
      if (audioChunkCount % 100 === 0) {
        console.log(`[AudioService] Processed ${audioChunkCount} audio chunks (buffer: ${data.length} bytes)`);
      }

      frameBuffer = Buffer.concat([frameBuffer, data]);

      // Process complete frames
      while (frameBuffer.length >= frameBytes) {
        const chunk = frameBuffer.subarray(0, frameBytes);
        frameBuffer = frameBuffer.subarray(frameBytes);

        // Convert to PCM array for wake word detection
        const pcmArray = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
        const keywordIndex = detector.process(pcmArray);

        if (keywordIndex >= 0) {
          console.log('[AudioService] Wake word detected - capturing speech...');
          this.handleWakeWordDetection(micStream, onWakeWord);
        }
      }
    });

    micStream.on('error', (error) => {
      console.error('[AudioService] Microphone stream error:', error);
    });
  }

  /**
   * Handles wake word detection and captures user speech
   */
  private static async handleWakeWordDetection(
    micStream: NodeJS.ReadableStream,
    onWakeWord: (intent: IntentMessage | null, text: string) => void
  ): Promise<void> {
    try {
      // Capture speech for 3.5 seconds
      const audioData = await this.captureUserSpeech(micStream, 3500);
      
      // Convert PCM to WAV for transcription
      const wavBuffer = this.pcmToWav(audioData, 16000, 1);
      
      // Transcribe and parse intent
      const { intent, text } = await this.transcribeAndParseIntent(wavBuffer);
      
      console.log(`[AudioService] Transcribed: "${text}"`);
      if (intent) {
        console.log(`[AudioService] Detected intent: ${intent.intent}`);
      } else {
        console.log('[AudioService] No media control intent - treating as conversational');
      }

      // Call the callback with results
      onWakeWord(intent, text);

    } catch (error) {
      console.error('[AudioService] Speech processing failed:', (error as Error).message);
      onWakeWord(null, '');
    }
  }

  /**
   * Captures user speech for a specified duration
   */
  private static async captureUserSpeech(stream: NodeJS.ReadableStream, durationMs: number): Promise<Buffer> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const onData = (chunk: Buffer) => chunks.push(chunk);
      
      stream.on('data', onData);
      
      setTimeout(() => {
        stream.off('data', onData);
        resolve(Buffer.concat(chunks));
      }, durationMs);
    });
  }

  /**
   * Transcribes audio and parses for media control intents
   */
  private static async transcribeAndParseIntent(wavBuffer: Buffer): Promise<{
    intent: IntentMessage | null;
    text: string;
  }> {
    const openai = this.getOpenAIClient();
    if (!openai) {
      console.warn('[AudioService] OpenAI API key not available for transcription');
      return { intent: null, text: '' };
    }

    try {
      // Transcribe audio
      const file = await OpenAI.toFile(wavBuffer, 'speech.wav');
      const transcription = await openai.audio.transcriptions.create({
        file,
        model: 'whisper-1',
        response_format: 'json',
        temperature: 0
      } as any);

      const text = (transcription as any).text ?? '';
      const intent = this.parseIntentFromText(text);

      return { intent, text };

    } catch (error) {
      console.error('[AudioService] Transcription failed:', (error as Error).message);
      return { intent: null, text: '' };
    }
  }

  /**
   * Parses media control intents from transcribed text
   */
  static parseIntentFromText(text: string): IntentMessage | null {
    const normalized = text.toLowerCase().trim();

    // Rewind / go back commands
    let match = normalized.match(/\b(rewind|go back|back)\b\s*(?:by|for)?\s*(\d+)?\s*(seconds?|secs?|s|minutes?|mins?|m)?/i);
    if (match) {
      const amount = Number(match[2] ?? '10');
      const unit = (match[3] ?? 's').toLowerCase();
      const seconds = unit.startsWith('m') ? amount * 60 : amount;
      return { intent: 'rewind', value: seconds };
    }

    // Forward / skip commands
    match = normalized.match(/\b(forward|go forward|skip ahead|ahead)\b\s*(?:by|for)?\s*(\d+)?\s*(seconds?|secs?|s|minutes?|mins?|m)?/i);
    if (match) {
      const amount = Number(match[2] ?? '10');
      const unit = (match[3] ?? 's').toLowerCase();
      const seconds = unit.startsWith('m') ? amount * 60 : amount;
      return { intent: 'forward', value: seconds };
    }

    // Play/pause commands
    if (/\b(pause|stop)\b/.test(normalized)) {
      return { intent: 'pause' };
    }
    if (/\b(play|resume)\b/.test(normalized)) {
      return { intent: 'play' };
    }

    // Speed commands
    match = normalized.match(/\b(speed|playback speed)\b.*?(?:to|at)?\s*([0-9]+(?:\.[0-9]+)?)/);
    if (match) {
      return { intent: 'set_speed', value: Number(match[2]) };
    }
    if (/\bfaster\b/.test(normalized)) {
      return { intent: 'set_speed', value: 1.25 };
    }
    if (/\bslower\b/.test(normalized)) {
      return { intent: 'set_speed', value: 0.75 };
    }

    // Volume commands
    match = normalized.match(/\bvolume\b.*?(?:to|at)?\s*(\d{1,3})\s*%?/);
    if (match) {
      return { intent: 'set_volume', value: Math.min(100, Number(match[1])) };
    }

    // Jump to phrase commands
    match = normalized.match(/\b(jump|go) to\b\s*(?:where\s*)?(.+)/);
    if (match) {
      return { intent: 'jump_to_phrase', value: match[2].trim() };
    }

    return null;
  }

  /**
   * Converts PCM audio to WAV format
   */
  static pcmToWav(pcm: Buffer, sampleRate = 16000, channels = 1): Buffer {
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
   * Validates audio configuration
   */
  static validateAudioConfig(): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (audioConfig.enableAudio) {
      if (!audioConfig.pvAccessKey) {
        errors.push('PV_ACCESS_KEY is required when ENABLE_AUDIO is true');
      }

      if (audioConfig.sensitivity < 0 || audioConfig.sensitivity > 1) {
        errors.push('SENSITIVITY must be between 0 and 1');
      }

      if (!aiConfig.openAiApiKey) {
        errors.push('OPENAI_API_KEY is required for speech transcription');
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Gets audio system status
   */
  static getAudioStatus(): {
    enabled: boolean;
    wakeKeyword: string;
    sensitivity: number;
    hasApiKeys: boolean;
  } {
    return {
      enabled: audioConfig.enableAudio,
      wakeKeyword: audioConfig.wakeKeyword,
      sensitivity: audioConfig.sensitivity,
      hasApiKeys: Boolean(audioConfig.pvAccessKey && aiConfig.openAiApiKey)
    };
  }
}