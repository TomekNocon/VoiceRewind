/**
 * File system cache service for transcripts and embeddings
 */
import fs from 'fs';
import path from 'path';
import type { TranscriptSegment, EmbeddingCache } from '../types/index.js';
import { cacheConfig } from '../config/index.js';

export class CacheService {
  /**
   * Ensures cache directories exist
   */
  static ensureDirectories(): void {
    try {
      fs.mkdirSync(cacheConfig.transcriptDir, { recursive: true });
      fs.mkdirSync(cacheConfig.mediaDir, { recursive: true });
    } catch (error) {
      console.warn('Failed to create cache directories:', error);
    }
  }

  /**
   * Gets file path for transcript cache
   */
  private static transcriptPath(videoId: string): string {
    return path.join(cacheConfig.transcriptDir, `${videoId}.json`);
  }

  /**
   * Gets file path for embedding cache
   */
  private static embeddingPath(videoId: string): string {
    return path.join(cacheConfig.transcriptDir, `${videoId}.embeddings.json`);
  }

  /**
   * Gets file path for media files
   */
  static mediaPath(filename: string): string {
    return path.join(cacheConfig.mediaDir, filename);
  }

  /**
   * Reads transcript from disk cache
   */
  static readTranscript(videoId: string): TranscriptSegment[] | null {
    try {
      const filePath = this.transcriptPath(videoId);
      if (!fs.existsSync(filePath)) {
        return null;
      }

      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      
      // Handle both direct arrays and wrapped objects
      if (Array.isArray(parsed)) {
        return parsed;
      }
      
      if (Array.isArray(parsed?.segments)) {
        return parsed.segments;
      }

      return null;
    } catch (error) {
      console.warn(`Failed to read transcript cache for ${videoId}:`, error);
      return null;
    }
  }

  /**
   * Writes transcript to disk cache
   */
  static writeTranscript(videoId: string, segments: TranscriptSegment[]): void {
    try {
      this.ensureDirectories();
      const filePath = this.transcriptPath(videoId);
      fs.writeFileSync(filePath, JSON.stringify(segments, null, 2), 'utf8');
    } catch (error) {
      console.warn(`Failed to write transcript cache for ${videoId}:`, error);
    }
  }

  /**
   * Reads embeddings from disk cache
   */
  static readEmbeddings(videoId: string): EmbeddingCache | null {
    try {
      const filePath = this.embeddingPath(videoId);
      if (!fs.existsSync(filePath)) {
        return null;
      }

      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw) as EmbeddingCache;
    } catch (error) {
      console.warn(`Failed to read embeddings cache for ${videoId}:`, error);
      return null;
    }
  }

  /**
   * Writes embeddings to disk cache
   */
  static writeEmbeddings(videoId: string, embeddings: EmbeddingCache): void {
    try {
      this.ensureDirectories();
      const filePath = this.embeddingPath(videoId);
      fs.writeFileSync(filePath, JSON.stringify(embeddings, null, 2), 'utf8');
    } catch (error) {
      console.warn(`Failed to write embeddings cache for ${videoId}:`, error);
    }
  }

  /**
   * Checks if transcript cache exists
   */
  static hasTranscript(videoId: string): boolean {
    const filePath = this.transcriptPath(videoId);
    return fs.existsSync(filePath);
  }

  /**
   * Checks if embeddings cache exists
   */
  static hasEmbeddings(videoId: string): boolean {
    const filePath = this.embeddingPath(videoId);
    return fs.existsSync(filePath);
  }

  /**
   * Clears cache for a specific video
   */
  static clearVideoCache(videoId: string): void {
    try {
      const transcriptPath = this.transcriptPath(videoId);
      const embeddingPath = this.embeddingPath(videoId);
      
      if (fs.existsSync(transcriptPath)) {
        fs.unlinkSync(transcriptPath);
      }
      
      if (fs.existsSync(embeddingPath)) {
        fs.unlinkSync(embeddingPath);
      }
    } catch (error) {
      console.warn(`Failed to clear cache for ${videoId}:`, error);
    }
  }

  /**
   * Gets cache statistics
   */
  static getCacheStats(): { transcriptCount: number; embeddingCount: number; mediaCount: number } {
    try {
      const transcriptFiles = fs.readdirSync(cacheConfig.transcriptDir)
        .filter(f => f.endsWith('.json') && !f.endsWith('.embeddings.json'));
      
      const embeddingFiles = fs.readdirSync(cacheConfig.transcriptDir)
        .filter(f => f.endsWith('.embeddings.json'));
      
      const mediaFiles = fs.readdirSync(cacheConfig.mediaDir);

      return {
        transcriptCount: transcriptFiles.length,
        embeddingCount: embeddingFiles.length,
        mediaCount: mediaFiles.length
      };
    } catch {
      return { transcriptCount: 0, embeddingCount: 0, mediaCount: 0 };
    }
  }
}