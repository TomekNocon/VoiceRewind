/**
 * Service for web search functionality using Tavily API
 */
import OpenAI from 'openai';
import type { SearchResult } from '../types/index.js';
import { aiConfig } from '../config/index.js';

export class SearchService {
  private static openai: OpenAI | null = null;

  /**
   * Gets OpenAI client for answer synthesis
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
   * Performs web search using Tavily API
   */
  static async searchWeb(query: string): Promise<SearchResult[]> {
    if (!aiConfig.tavilyApiKey) {
      console.warn('[SearchService] Tavily API key not available');
      return [];
    }

    try {
      console.log(`[SearchService] Searching web for: "${query}"`);

      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: aiConfig.tavilyApiKey,
          query,
          search_depth: 'basic',
          max_results: 5,
          include_answer: false
        })
      });

      if (!response.ok) {
        throw new Error(`Tavily API responded with status ${response.status}`);
      }

      const data: any = await response.json();
      const results: any[] = data?.results ?? [];

      const searchResults = results.map(result => ({
        title: String(result.title ?? ''),
        url: String(result.url ?? ''),
        content: String(result.content ?? '')
      }));

      console.log(`[SearchService] Found ${searchResults.length} results`);
      return searchResults;

    } catch (error) {
      console.error('[SearchService] Web search failed:', (error as Error).message);
      return [];
    }
  }

  /**
   * Synthesizes an answer from search results using OpenAI
   */
  static async synthesizeAnswer(
    question: string, 
    searchResults: SearchResult[], 
    context?: string
  ): Promise<string> {
    const openai = this.getOpenAIClient();
    if (!openai) {
      console.warn('[SearchService] OpenAI API key not available for answer synthesis');
      return this.fallbackAnswer(searchResults);
    }

    try {
      const systemPrompt = `You are a helpful research assistant. Answer concisely (3-6 sentences). Use the provided web results and optional video context. Include inline citations like [1], [2] mapping to the provided sources by index. If unsure, say so.`;

      const sourceList = searchResults
        .map((result, index) => `[${index + 1}] ${result.title} - ${result.url}\n${result.content}`)
        .join('\n\n');

      const userPrompt = [
        `Question: ${question}`,
        context ? `\nVideo context:\n${context}` : '\nVideo context: (none)',
        `\nWeb results:\n${sourceList}`
      ].join('');

      console.log(`[SearchService] Synthesizing answer using ${aiConfig.chatModel}`);

      const completion = await openai.chat.completions.create({
        model: aiConfig.chatModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 500
      });

      const answer = completion.choices[0]?.message?.content ?? '';
      
      if (!answer.trim()) {
        return this.fallbackAnswer(searchResults);
      }

      console.log('[SearchService] Answer synthesized successfully');
      return answer;

    } catch (error) {
      console.error('[SearchService] Answer synthesis failed:', (error as Error).message);
      return this.fallbackAnswer(searchResults);
    }
  }

  /**
   * Creates a fallback answer when AI synthesis fails
   */
  private static fallbackAnswer(searchResults: SearchResult[]): string {
    if (searchResults.length === 0) {
      return 'I could not find relevant information to answer your question.';
    }

    const topResult = searchResults[0];
    const summary = topResult.content.length > 200 
      ? topResult.content.substring(0, 200) + '...'
      : topResult.content;

    return `Based on my search, here's what I found:\n\n${summary}\n\nSource: ${topResult.title} - ${topResult.url}`;
  }

  /**
   * Validates search query
   */
  static validateQuery(query: string): { isValid: boolean; error?: string } {
    const trimmed = query.trim();

    if (!trimmed) {
      return { isValid: false, error: 'Query cannot be empty' };
    }

    if (trimmed.length < 2) {
      return { isValid: false, error: 'Query must be at least 2 characters long' };
    }

    if (trimmed.length > 500) {
      return { isValid: false, error: 'Query too long (max 500 characters)' };
    }

    // Check for potentially harmful queries
    const suspiciousPatterns = [
      /^(DELETE|DROP|UPDATE|INSERT)\s/i,
      /<script[^>]*>.*?<\/script>/i,
      /javascript:/i
    ];

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(trimmed)) {
        return { isValid: false, error: 'Query contains suspicious content' };
      }
    }

    return { isValid: true };
  }

  /**
   * Formats search results for display
   */
  static formatResultsForDisplay(results: SearchResult[]): Array<{ i: number; title: string; url: string }> {
    return results.map((result, index) => ({
      i: index + 1,
      title: result.title || 'Untitled',
      url: result.url || '#'
    }));
  }
}