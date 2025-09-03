/**
 * Test suite for SearchService
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SearchService } from '../../services/SearchService.js';

// Mock the config
vi.mock('../../config/index.js', () => ({
  aiConfig: {
    openAiApiKey: 'test-openai-key',
    tavilyApiKey: 'test-tavily-key',
    chatModel: 'gpt-4o-mini'
  }
}));

// Mock OpenAI
vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: 'Mocked answer from OpenAI' } }]
          })
        }
      }
    }))
  };
});

describe('SearchService', () => {
  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    
    // Mock fetch globally
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('validateQuery', () => {
    it('should accept valid queries', () => {
      const validQueries = [
        'What is the weather today?',
        'Tour de France winner 2023',
        'How to cook pasta',
        'JavaScript async/await'
      ];

      validQueries.forEach(query => {
        const result = SearchService.validateQuery(query);
        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });
    });

    it('should reject empty queries', () => {
      const invalidQueries = ['', '   ', '\t\n'];

      invalidQueries.forEach(query => {
        const result = SearchService.validateQuery(query);
        expect(result.isValid).toBe(false);
        expect(result.error).toBeDefined();
      });
    });

    it('should reject queries that are too long', () => {
      const longQuery = 'a'.repeat(501);
      const result = SearchService.validateQuery(longQuery);
      
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('too long');
    });

    it('should reject potentially harmful queries', () => {
      const maliciousQueries = [
        '<script>alert("xss")</script>',
        'javascript:alert(1)',
        'DELETE FROM users',
        'DROP TABLE users'
      ];

      maliciousQueries.forEach(query => {
        const result = SearchService.validateQuery(query);
        expect(result.isValid).toBe(false);
        expect(result.error).toBeDefined();
      });
    });
  });

  describe('formatResultsForDisplay', () => {
    it('should format search results correctly', () => {
      const mockResults = [
        { title: 'First Result', url: 'https://example.com/1', content: 'Content 1' },
        { title: 'Second Result', url: 'https://example.com/2', content: 'Content 2' },
        { title: '', url: 'https://example.com/3', content: 'Content 3' }
      ];

      const formatted = SearchService.formatResultsForDisplay(mockResults);

      expect(formatted).toHaveLength(3);
      expect(formatted[0]).toEqual({ i: 1, title: 'First Result', url: 'https://example.com/1' });
      expect(formatted[1]).toEqual({ i: 2, title: 'Second Result', url: 'https://example.com/2' });
      expect(formatted[2]).toEqual({ i: 3, title: 'Untitled', url: 'https://example.com/3' });
    });

    it('should handle empty results array', () => {
      const formatted = SearchService.formatResultsForDisplay([]);
      expect(formatted).toEqual([]);
    });
  });

  describe('searchWeb', () => {
    it('should return search results on successful API call', async () => {
      const mockApiResponse = {
        results: [
          { title: 'Test Result', url: 'https://test.com', content: 'Test content' }
        ]
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockApiResponse)
      });

      const results = await SearchService.searchWeb('test query');

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        title: 'Test Result',
        url: 'https://test.com',
        content: 'Test content'
      });
    });

    it('should return empty array when API call fails', async () => {
      (global.fetch as any).mockRejectedValueOnce(new Error('API Error'));

      const results = await SearchService.searchWeb('test query');

      expect(results).toEqual([]);
    });

    it('should handle non-200 status codes', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 429
      });

      const results = await SearchService.searchWeb('test query');

      expect(results).toEqual([]);
    });
  });

  describe('synthesizeAnswer', () => {
    it('should synthesize answer using OpenAI', async () => {
      const mockResults = [
        { title: 'Test', url: 'https://test.com', content: 'Test content' }
      ];

      const answer = await SearchService.synthesizeAnswer('test question', mockResults);

      expect(answer).toBe('Mocked answer from OpenAI');
    });

    it('should provide fallback answer when OpenAI fails', async () => {
      // Mock OpenAI to throw error
      const OpenAI = await import('openai');
      const mockOpenAI = new OpenAI.default({ apiKey: 'test' });
      mockOpenAI.chat.completions.create = vi.fn().mockRejectedValue(new Error('OpenAI Error'));

      const mockResults = [
        { title: 'Test Result', url: 'https://test.com', content: 'This is test content for fallback' }
      ];

      const answer = await SearchService.synthesizeAnswer('test question', mockResults);

      expect(answer).toContain('Based on my search');
      expect(answer).toContain('Test Result');
    });

    it('should handle empty search results', async () => {
      const answer = await SearchService.synthesizeAnswer('test question', []);

      expect(answer).toContain('could not find relevant information');
    });
  });
});