/**
 * Service for generating and managing text embeddings
 */
import OpenAI from 'openai';
import type { TranscriptSegment, EmbeddingCache, EmbeddingItem } from '../types/index.js';
import { CacheService } from './CacheService.js';
import { aiConfig } from '../config/index.js';

export class EmbeddingService {
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
   * Ensures embeddings exist for given segments
   */
  static async ensureEmbeddings(
    videoId: string, 
    segments: TranscriptSegment[], 
    forceRefresh = false
  ): Promise<EmbeddingCache | null> {
    const openai = this.getOpenAIClient();
    if (!openai) {
      console.warn('[EmbeddingService] OpenAI API key not available');
      return null;
    }

    // Check cache first
    if (!forceRefresh) {
      const cached = CacheService.readEmbeddings(videoId);
      if (cached && cached.model === aiConfig.embeddingModel && cached.items.length > 0) {
        console.log(`[EmbeddingService] Cache hit for ${videoId} (${cached.items.length} embeddings)`);
        return cached;
      }
    }

    // Generate new embeddings
    return await this.generateEmbeddings(videoId, segments);
  }

  /**
   * Generates embeddings for transcript segments
   */
  private static async generateEmbeddings(
    videoId: string, 
    segments: TranscriptSegment[]
  ): Promise<EmbeddingCache | null> {
    const openai = this.getOpenAIClient();
    if (!openai) return null;

    try {
      console.log(`[EmbeddingService] Generating embeddings for ${videoId} (${segments.length} segments)`);

      // Prepare input texts
      const texts = segments.map(segment => segment.text || '').filter(text => text.trim().length > 0);
      
      if (texts.length === 0) {
        console.warn('[EmbeddingService] No valid text segments found');
        return null;
      }

      // Generate embeddings in batches to avoid rate limits
      const batchSize = 100;
      const allEmbeddings: number[][] = [];

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        console.log(`[EmbeddingService] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(texts.length / batchSize)}`);

        const response = await openai.embeddings.create({
          model: aiConfig.embeddingModel,
          input: batch,
        });

        const batchEmbeddings = response.data.map(item => item.embedding);
        allEmbeddings.push(...batchEmbeddings);
      }

      // Create embedding items
      const items: EmbeddingItem[] = allEmbeddings.map((embedding, index) => {
        const segment = segments[index];
        const start = this.getSegmentStart(segment);
        const duration = segment.duration || 0;

        return {
          idx: index,
          start,
          duration,
          text: texts[index],
          embedding
        };
      });

      // Create cache object
      const cache: EmbeddingCache = {
        model: aiConfig.embeddingModel,
        dims: allEmbeddings[0]?.length || 0,
        items
      };

      // Save to cache
      CacheService.writeEmbeddings(videoId, cache);
      console.log(`[EmbeddingService] Generated and cached ${items.length} embeddings`);

      return cache;

    } catch (error) {
      console.error('[EmbeddingService] Failed to generate embeddings:', (error as Error).message);
      return null;
    }
  }

  /**
   * Performs semantic search using cosine similarity
   */
  static async semanticSearch(
    videoId: string,
    query: string,
    embeddings: EmbeddingCache,
    topK = 5
  ): Promise<{
    start: number;
    score: number;
    text: string;
    index: number;
    candidates: Array<{ start: number; score: number; text: string }>;
  } | null> {
    const openai = this.getOpenAIClient();
    if (!openai) {
      console.warn('[EmbeddingService] OpenAI API key not available for semantic search');
      return null;
    }

    try {
      // Generate query embedding
      const queryResponse = await openai.embeddings.create({
        model: aiConfig.embeddingModel,
        input: query,
      });

      const queryEmbedding = queryResponse.data[0].embedding;

      // Calculate similarities
      const similarities = embeddings.items.map(item => ({
        ...item,
        score: this.cosineSimilarity(queryEmbedding, item.embedding)
      }));

      // Sort by score
      similarities.sort((a, b) => b.score - a.score);

      // Get best result
      const best = similarities[0];
      if (!best) {
        return null;
      }

      // Prepare candidates
      const candidates = similarities
        .slice(0, topK)
        .map(item => ({
          start: item.start,
          score: item.score,
          text: item.text
        }));

      return {
        start: best.start,
        score: best.score,
        text: best.text,
        index: best.idx,
        candidates
      };

    } catch (error) {
      console.error('[EmbeddingService] Semantic search failed:', (error as Error).message);
      return null;
    }
  }

  /**
   * Calculates cosine similarity between two vectors
   */
  private static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have the same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Extracts start time from segment
   */
  private static getSegmentStart(segment: TranscriptSegment): number {
    if (typeof segment.start === 'number') {
      return segment.start;
    }
    
    if (typeof segment.offset === 'number') {
      return segment.offset / 1000; // Convert milliseconds to seconds
    }
    
    return 0;
  }

  /**
   * Clears embeddings cache for a video
   */
  static clearCache(videoId: string): void {
    CacheService.clearVideoCache(videoId);
    console.log(`[EmbeddingService] Cleared embeddings cache for ${videoId}`);
  }
}