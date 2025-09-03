/**
 * Test setup and configuration
 */
import { vi } from 'vitest';

// Mock environment variables for tests
process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.ELEVENLABS_API_KEY = 'test-elevenlabs-key';
process.env.ELEVENLABS_VOICE_ID = 'test-voice-id';
process.env.TAVILY_API_KEY = 'test-tavily-key';
process.env.PORT = '17321';

// Mock fetch globally
global.fetch = vi.fn();

// Mock console methods to reduce test noise
global.console = {
  ...console,
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};

// Setup test timeouts
vi.setConfig({ testTimeout: 10000 });