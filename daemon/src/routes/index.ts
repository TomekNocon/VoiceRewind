/**
 * HTTP routes for the VoiceRewind daemon API
 */
import express from 'express';
import type { Request, Response } from 'express';
import { TranscriptService } from '../services/TranscriptService.js';
import { EmbeddingService } from '../services/EmbeddingService.js';
import { SearchService } from '../services/SearchService.js';
import { ElevenLabsService } from '../services/ElevenLabsService.js';
import { CacheService } from '../services/CacheService.js';
import { aiConfig, serverConfig, cacheConfig } from '../config/index.js';

export function createRoutes(): express.Router {
  const router = express.Router();

  /**
   * Health check endpoint
   */
  router.get('/health', (_req: Request, res: Response) => {
    const cacheStats = CacheService.getCacheStats();
    
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      config: {
        hasOpenAI: Boolean(aiConfig.openAiApiKey),
        hasElevenLabs: Boolean(aiConfig.elevenLabsApiKey),
        hasTavily: Boolean(aiConfig.tavilyApiKey),
        embeddingModel: aiConfig.embeddingModel,
        chatModel: aiConfig.chatModel
      },
      cache: cacheStats
    });
  });

  /**
   * Get YouTube transcript with fallback to Whisper
   */
  router.get('/transcript', async (req: Request, res: Response) => {
    try {
      const videoId = String(req.query.videoId ?? '').trim();
      const forceRefresh = String(req.query.force ?? '').trim() === '1';

      if (!videoId) {
        return res.status(400).json({ error: 'Missing required parameter: videoId' });
      }

      console.log(`[API] /transcript request for ${videoId} (force: ${forceRefresh})`);

      const segments = await TranscriptService.getTranscript(videoId, forceRefresh);
      
      res.json({
        ok: true,
        videoId,
        segments,
        count: segments.length,
        cached: !forceRefresh && CacheService.hasTranscript(videoId)
      });

    } catch (error) {
      console.error('[API] /transcript error:', (error as Error).message);
      res.status(500).json({
        error: 'Failed to fetch transcript',
        details: (error as Error).message
      });
    }
  });

  /**
   * Perform semantic search on video transcript
   */
  router.get('/semantic_search', async (req: Request, res: Response) => {
    try {
      const videoId = String(req.query.videoId ?? '').trim();
      const query = String(req.query.q ?? '').trim();
      const forceRefresh = String(req.query.force ?? '').trim() === '1';

      if (!videoId || !query) {
        return res.status(400).json({ error: 'Missing required parameters: videoId and q' });
      }

      console.log(`[API] /semantic_search for "${query}" in ${videoId}`);

      // Get transcript segments
      const segments = await TranscriptService.getTranscript(videoId, forceRefresh);
      if (segments.length === 0) {
        return res.json({
          ok: true,
          videoId,
          query,
          start: 0,
          score: 0,
          text: '',
          index: -1,
          candidates: []
        });
      }

      // Ensure embeddings exist
      const embeddings = await EmbeddingService.ensureEmbeddings(videoId, segments, forceRefresh);
      if (!embeddings) {
        return res.status(500).json({ error: 'Failed to generate embeddings' });
      }

      // Perform search
      const searchResult = await EmbeddingService.semanticSearch(videoId, query, embeddings);
      if (!searchResult) {
        return res.status(500).json({ error: 'Semantic search failed' });
      }

      res.json({
        ok: true,
        videoId,
        query,
        ...searchResult
      });

    } catch (error) {
      console.error('[API] /semantic_search error:', (error as Error).message);
      res.status(500).json({
        error: 'Semantic search failed',
        details: (error as Error).message
      });
    }
  });

  /**
   * Query conversational agent with web search
   */
  router.post('/agent/query', async (req: Request, res: Response) => {
    try {
      const { q, videoId, currentTime, sessionId } = req.body;

      // Validate input
      const queryValidation = SearchService.validateQuery(q);
      if (!queryValidation.isValid) {
        return res.status(400).json({ error: queryValidation.error });
      }

      const cleanQuery = String(q).trim();
      const cleanVideoId = String(videoId ?? '').trim();
      const timeSeconds = Number(currentTime ?? 0);
      const cleanSessionId = String(sessionId ?? 'default').trim();

      console.log(`[API] /agent/query: "${cleanQuery}" (session: ${cleanSessionId})`);

      // Build context from video transcript if available
      let context = '';
      if (cleanVideoId) {
        try {
          const segments = await TranscriptService.getTranscript(cleanVideoId, false);
          if (segments.length > 0) {
            // Get segments around current time (±90 seconds)
            const contextSegments = segments
              .filter(segment => {
                const segmentStart = typeof segment.start === 'number' 
                  ? segment.start 
                  : (typeof segment.offset === 'number' ? segment.offset / 1000 : 0);
                return Math.abs(segmentStart - timeSeconds) <= 90;
              })
              .slice(0, 20)
              .map(segment => segment.text)
              .join(' ');

            if (contextSegments) {
              context = `Video transcript excerpt near t=${Math.floor(timeSeconds)}s: ${contextSegments}`;
            }
          }
        } catch (error) {
          console.warn('[API] Failed to get transcript context:', (error as Error).message);
        }
      }

      // Try ElevenLabs Conversational AI first
      if (aiConfig.elevenLabsApiKey && aiConfig.elevenLabsAgentId) {
        try {
          const response = await ElevenLabsService.sendConversationalMessage(
            cleanSessionId,
            cleanQuery,
            context || undefined
          );

          return res.json({
            ok: true,
            text: response.text,
            audioUrl: response.audioUrl,
            sources: [],
            method: 'elevenlabs_conversational'
          });
        } catch (error) {
          console.warn('[API] ElevenLabs conversational AI failed:', (error as Error).message);
          // Continue to fallback
        }
      }

      // Fallback: Web search + OpenAI + ElevenLabs TTS
      const searchResults = await SearchService.searchWeb(cleanQuery);
      const answerText = await SearchService.synthesizeAnswer(cleanQuery, searchResults, context);
      const audioUrl = await ElevenLabsService.textToSpeech(answerText);
      const formattedSources = SearchService.formatResultsForDisplay(searchResults);

      res.json({
        ok: true,
        text: answerText,
        audioUrl,
        sources: formattedSources,
        method: 'web_search_fallback'
      });

    } catch (error) {
      console.error('[API] /agent/query error:', (error as Error).message);
      res.status(500).json({
        error: 'Agent query failed',
        details: (error as Error).message
      });
    }
  });

  /**
   * Web search tool endpoint (for external integrations)
   */
  router.post('/tools/web_search', async (req: Request, res: Response) => {
    try {
      // Check authentication
      if (!serverConfig.toolSecret || req.header('x-tool-secret') !== serverConfig.toolSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const query = String(req.body?.query ?? req.body?.q ?? '').trim();
      const context = String(req.body?.context ?? '').trim();

      if (!query) {
        return res.status(400).json({ error: 'Missing required parameter: query' });
      }

      console.log(`[API] /tools/web_search: "${query}"`);

      const searchResults = await SearchService.searchWeb(query);
      const answer = await SearchService.synthesizeAnswer(query, searchResults, context || undefined);
      const formattedSources = SearchService.formatResultsForDisplay(searchResults);

      res.json({
        ok: true,
        answer,
        sources: formattedSources
      });

    } catch (error) {
      console.error('[API] /tools/web_search error:', (error as Error).message);
      res.status(500).json({
        error: 'Web search tool failed',
        details: (error as Error).message
      });
    }
  });

  /**
   * Clear cache for specific video
   */
  router.delete('/cache/:videoId', (req: Request, res: Response) => {
    try {
      const videoId = req.params.videoId;
      if (!videoId) {
        return res.status(400).json({ error: 'Missing videoId parameter' });
      }

      CacheService.clearVideoCache(videoId);
      console.log(`[API] Cleared cache for video: ${videoId}`);

      res.json({
        ok: true,
        message: `Cache cleared for video ${videoId}`
      });

    } catch (error) {
      console.error('[API] Cache clear error:', (error as Error).message);
      res.status(500).json({
        error: 'Failed to clear cache',
        details: (error as Error).message
      });
    }
  });

  /**
   * Get cache statistics
   */
  router.get('/cache/stats', (_req: Request, res: Response) => {
    try {
      const stats = CacheService.getCacheStats();
      res.json({
        ok: true,
        stats,
        paths: {
          transcripts: cacheConfig.transcriptDir,
          media: cacheConfig.mediaDir
        }
      });
    } catch (error) {
      console.error('[API] Cache stats error:', (error as Error).message);
      res.status(500).json({
        error: 'Failed to get cache stats',
        details: (error as Error).message
      });
    }
  });

  /**
   * Handle OPTIONS requests for CORS
   */
  router.options('/tools/web_search', (_req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-tool-secret');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.status(204).end();
  });

  return router;
}