/**
 * Service for fetching YouTube transcripts with Whisper fallback
 */
import os from 'os';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import type { TranscriptSegment } from '../types/index.js';
import { CacheService } from './CacheService.js';
import { aiConfig } from '../config/index.js';

export class TranscriptService {
  private static openai: OpenAI | null = null;

  /**
   * Gets OpenAI client (lazy initialization)
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
   * Gets transcript for a video (with caching)
   */
  static async getTranscript(videoId: string, forceRefresh = false): Promise<TranscriptSegment[]> {
    // Check cache first (unless forced refresh)
    if (!forceRefresh) {
      const cached = CacheService.readTranscript(videoId);
      if (cached && cached.length > 0) {
        console.log(`[TranscriptService] Cache hit for ${videoId} (${cached.length} segments)`);
        return cached;
      }
    }

    // Try to fetch new transcript
    let segments: TranscriptSegment[] = [];

    if (!forceRefresh) {
      segments = await this.fetchYouTubeTranscript(videoId);
    }

    // Fallback to Whisper if no segments found
    if (segments.length === 0) {
      segments = await this.fetchWhisperTranscript(videoId);
    }

    // Cache the result if we got segments
    if (segments.length > 0) {
      CacheService.writeTranscript(videoId, segments);
    }

    return segments;
  }

  /**
   * Fetches transcript from YouTube's timed text API
   */
  private static async fetchYouTubeTranscript(videoId: string): Promise<TranscriptSegment[]> {
    // Try library first
    const librarySegments = await this.tryLibraryTranscript(videoId);
    if (librarySegments.length > 0) {
      return librarySegments;
    }

    // Try direct API as fallback
    return await this.tryDirectApiTranscript(videoId);
  }

  /**
   * Uses youtube-transcript library with multiple languages
   */
  private static async tryLibraryTranscript(videoId: string): Promise<TranscriptSegment[]> {
    try {
      const { YoutubeTranscript } = await import('youtube-transcript');
      const languages = ['en', 'en-US', 'en-GB', 'auto', 'pl', 'es', 'de', 'fr'];

      for (const lang of languages) {
        try {
          // @ts-expect-error - library types don't include lang parameter
          const segments = await YoutubeTranscript.fetchTranscript(videoId, { lang });
          
          if (Array.isArray(segments) && segments.length > 0) {
            console.log(`[TranscriptService] Library transcript success (${lang}): ${segments.length} segments`);
            return this.normalizeSegments(segments);
          }
        } catch (error) {
          console.warn(`[TranscriptService] Library failed for language ${lang}:`, (error as Error).message);
        }
      }
    } catch (error) {
      console.warn('[TranscriptService] youtube-transcript library not available:', (error as Error).message);
    }

    return [];
  }

  /**
   * Direct call to YouTube's timed text API
   */
  private static async tryDirectApiTranscript(videoId: string): Promise<TranscriptSegment[]> {
    try {
      const timedUrl = `https://www.youtube.com/api/timedtext?lang=en&v=${encodeURIComponent(videoId)}`;
      console.log('[TranscriptService] Trying direct API:', timedUrl);

      const response = await fetch(timedUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const xml = await response.text();
      const segments = await this.parseTimedTextXml(xml);
      
      if (segments.length > 0) {
        console.log(`[TranscriptService] Direct API success: ${segments.length} segments`);
        return segments;
      }
    } catch (error) {
      console.warn('[TranscriptService] Direct API failed:', (error as Error).message);
    }

    return [];
  }

  /**
   * Parses YouTube's timed text XML format
   */
  private static async parseTimedTextXml(xml: string): Promise<TranscriptSegment[]> {
    try {
      const { XMLParser } = await import('fast-xml-parser');
      const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
      const data: any = parser.parse(xml);
      
      const texts = data?.transcript?.text ?? [];
      const textArray = Array.isArray(texts) ? texts : [texts];
      
      return textArray
        .filter(Boolean)
        .map((t: any) => ({
          text: String(t['#text'] ?? ''),
          start: Number(t.start ?? 0),
          duration: Number(t.dur ?? 0)
        }))
        .filter((s: TranscriptSegment) => s.text.trim().length > 0);
    } catch (error) {
      console.warn('[TranscriptService] XML parsing failed:', (error as Error).message);
      return [];
    }
  }

  /**
   * Uses OpenAI Whisper as fallback (first 10 seconds only for cost control)
   */
  private static async fetchWhisperTranscript(videoId: string): Promise<TranscriptSegment[]> {
    const openai = this.getOpenAIClient();
    if (!openai) {
      console.warn('[TranscriptService] Whisper unavailable: OPENAI_API_KEY not set');
      return [];
    }

    let tmpDir: string | null = null;

    try {
      console.log(`[TranscriptService] Attempting Whisper transcription for ${videoId}`);
      
      // Import dependencies
      const { default: ytdl } = await import('@distube/ytdl-core');
      const ffmpegPath = (await import('ffmpeg-static')).default as string;
      const ffmpeg = (await import('fluent-ffmpeg')).default;
      ffmpeg.setFfmpegPath(ffmpegPath);

      // Create temp directory
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrw-'));
      const tmpMp4 = path.join(tmpDir, `${videoId}.mp4`);
      const tmpWav = path.join(tmpDir, `${videoId}.wav`);

      // Download audio
      await this.downloadAudio(ytdl, videoId, tmpMp4);
      console.log('[TranscriptService] Audio downloaded');

      // Convert to WAV
      await this.convertToWav(ffmpeg, tmpMp4, tmpWav);
      console.log('[TranscriptService] Audio converted to WAV');

      // Transcribe with Whisper
      const segments = await this.transcribeWithWhisper(openai, tmpWav);
      console.log(`[TranscriptService] Whisper transcription complete: ${segments.length} segments`);

      return segments;

    } catch (error) {
      console.error('[TranscriptService] Whisper transcription failed:', (error as Error).message);
      return [];
    } finally {
      // Cleanup temp files
      if (tmpDir) {
        this.cleanupTempDir(tmpDir);
      }
    }
  }

  /**
   * Downloads audio from YouTube
   */
  private static async downloadAudio(ytdl: any, videoId: string, outputPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const stream = ytdl(`https://www.youtube.com/watch?v=${videoId}`, {
        quality: 'highestaudio',
        filter: 'audioonly'
      });
      
      const file = fs.createWriteStream(outputPath);
      stream.pipe(file);
      
      file.on('finish', resolve);
      file.on('error', reject);
      stream.on('error', reject);
    });
  }

  /**
   * Converts audio to WAV format for Whisper
   */
  private static async convertToWav(ffmpeg: any, inputPath: string, outputPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .noVideo()
        .audioChannels(1)
        .audioFrequency(16000)
        .format('wav')
        .duration(10) // Limit to 10 seconds for cost control
        .save(outputPath)
        .on('end', resolve)
        .on('error', reject);
    });
  }

  /**
   * Transcribes WAV file with OpenAI Whisper
   */
  private static async transcribeWithWhisper(openai: OpenAI, wavPath: string): Promise<TranscriptSegment[]> {
    const file = await OpenAI.toFile(fs.createReadStream(wavPath) as any, 'audio.wav');
    
    const response = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'verbose_json',
      temperature: 0
    } as any);

    const segments: any[] = (response as any)?.segments ?? [];
    
    return segments
      .map((segment: any) => ({
        text: String(segment.text ?? '').trim(),
        start: Number(segment.start ?? 0),
        duration: Math.max(0, Number(segment.end ?? 0) - Number(segment.start ?? 0))
      }))
      .filter((segment: TranscriptSegment) => segment.text.length > 0);
  }

  /**
   * Normalizes segment format from library
   */
  private static normalizeSegments(segments: any[]): TranscriptSegment[] {
    return segments.map(segment => ({
      text: String(segment.text ?? ''),
      start: typeof segment.start === 'number' ? segment.start : (typeof segment.offset === 'number' ? segment.offset / 1000 : 0),
      duration: Number(segment.duration ?? 0)
    }));
  }

  /**
   * Cleanup temporary directory
   */
  private static cleanupTempDir(tmpDir: string): void {
    try {
      const files = fs.readdirSync(tmpDir);
      for (const file of files) {
        fs.unlinkSync(path.join(tmpDir, file));
      }
      fs.rmdirSync(tmpDir);
    } catch (error) {
      console.warn('[TranscriptService] Cleanup failed:', (error as Error).message);
    }
  }
}