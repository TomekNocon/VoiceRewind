/**
 * Input validation and error handling middleware
 */
import type { Request, Response, NextFunction } from 'express';
import type { IntentMessage } from '../types/index.js';

/**
 * Custom error class for validation errors
 */
export class ValidationError extends Error {
  constructor(message: string, public field?: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Custom error class for service errors
 */
export class ServiceError extends Error {
  constructor(message: string, public service: string, public code?: string) {
    super(message);
    this.name = 'ServiceError';
  }
}

/**
 * Validates video ID parameter
 */
export function validateVideoId(videoId: string): void {
  if (!videoId || typeof videoId !== 'string') {
    throw new ValidationError('Video ID is required', 'videoId');
  }

  const trimmed = videoId.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('Video ID cannot be empty', 'videoId');
  }

  if (trimmed.length < 5 || trimmed.length > 50) {
    throw new ValidationError('Video ID must be between 5 and 50 characters', 'videoId');
  }

  // YouTube video ID pattern
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new ValidationError('Video ID contains invalid characters', 'videoId');
  }
}

/**
 * Validates search query
 */
export function validateQuery(query: string): void {
  if (!query || typeof query !== 'string') {
    throw new ValidationError('Query is required', 'query');
  }

  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('Query cannot be empty', 'query');
  }

  if (trimmed.length > 1000) {
    throw new ValidationError('Query too long (max 1000 characters)', 'query');
  }

  // Check for suspicious content
  const suspiciousPatterns = [
    /<script[^>]*>.*?<\/script>/i,
    /javascript:/i,
    /on\w+\s*=/i,
    /eval\s*\(/i
  ];

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(trimmed)) {
      throw new ValidationError('Query contains potentially harmful content', 'query');
    }
  }
}

/**
 * Validates intent message
 */
export function validateIntentMessage(data: any): IntentMessage {
  if (!data || typeof data !== 'object') {
    throw new ValidationError('Intent message must be an object');
  }

  if (!data.intent || typeof data.intent !== 'string') {
    throw new ValidationError('Intent is required and must be a string', 'intent');
  }

  const validIntents = [
    'begin_listen',
    'end_listen',
    'rewind',
    'forward',
    'set_speed',
    'set_volume',
    'pause',
    'play',
    'jump_to_phrase',
    'agent_response'
  ];

  if (!validIntents.includes(data.intent)) {
    throw new ValidationError(`Invalid intent. Must be one of: ${validIntents.join(', ')}`, 'intent');
  }

  const intent: IntentMessage = { intent: data.intent };

  if (data.value !== undefined) {
    if (typeof data.value === 'number' || typeof data.value === 'string') {
      intent.value = data.value;
    } else if (typeof data.value === 'object' && data.value !== null) {
      // Validate agent_response value structure
      if (data.intent === 'agent_response') {
        if (!data.value.text || typeof data.value.text !== 'string') {
          throw new ValidationError('Agent response value must have a text property', 'value.text');
        }
        if (data.value.audioUrl && typeof data.value.audioUrl !== 'string') {
          throw new ValidationError('Agent response audioUrl must be a string', 'value.audioUrl');
        }
        intent.value = {
          text: data.value.text,
          audioUrl: data.value.audioUrl || ''
        };
      } else {
        throw new ValidationError('Complex value objects only allowed for agent_response intent', 'value');
      }
    } else {
      throw new ValidationError('Value must be a number, string, or object', 'value');
    }
  }

  return intent;
}

/**
 * Validates session ID
 */
export function validateSessionId(sessionId: string): string {
  if (!sessionId || typeof sessionId !== 'string') {
    return 'default';
  }

  const trimmed = sessionId.trim();
  if (trimmed.length === 0) {
    return 'default';
  }

  if (trimmed.length > 100) {
    throw new ValidationError('Session ID too long (max 100 characters)', 'sessionId');
  }

  // Allow alphanumeric, hyphens, and underscores
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new ValidationError('Session ID contains invalid characters', 'sessionId');
  }

  return trimmed;
}

/**
 * Middleware for handling validation errors
 */
export function validationErrorHandler(
  error: Error,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  if (error instanceof ValidationError) {
    res.status(400).json({
      error: 'Validation failed',
      message: error.message,
      field: error.field,
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (error instanceof ServiceError) {
    res.status(500).json({
      error: 'Service error',
      message: error.message,
      service: error.service,
      code: error.code,
      timestamp: new Date().toISOString()
    });
    return;
  }

  next(error);
}

/**
 * Async error wrapper for route handlers
 */
export function asyncHandler(fn: Function) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Rate limiting helper (simple in-memory implementation)
 */
class RateLimiter {
  private requests = new Map<string, number[]>();
  
  constructor(
    private maxRequests: number,
    private windowMs: number
  ) {}

  isAllowed(clientId: string): boolean {
    const now = Date.now();
    const requests = this.requests.get(clientId) || [];
    
    // Remove old requests outside the window
    const validRequests = requests.filter(timestamp => now - timestamp < this.windowMs);
    
    if (validRequests.length >= this.maxRequests) {
      return false;
    }

    // Add current request
    validRequests.push(now);
    this.requests.set(clientId, validRequests);
    
    return true;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [clientId, requests] of this.requests.entries()) {
      const validRequests = requests.filter(timestamp => now - timestamp < this.windowMs);
      if (validRequests.length === 0) {
        this.requests.delete(clientId);
      } else {
        this.requests.set(clientId, validRequests);
      }
    }
  }
}

// Export rate limiter instances
export const searchRateLimiter = new RateLimiter(10, 60000); // 10 requests per minute
export const transcriptRateLimiter = new RateLimiter(30, 60000); // 30 requests per minute

/**
 * Rate limiting middleware
 */
export function createRateLimitMiddleware(rateLimiter: RateLimiter, errorMessage = 'Rate limit exceeded') {
  return (req: Request, res: Response, next: NextFunction) => {
    const clientId = req.ip || 'unknown';
    
    if (!rateLimiter.isAllowed(clientId)) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        message: errorMessage,
        retryAfter: 60, // seconds
        timestamp: new Date().toISOString()
      });
    }

    next();
  };
}

// Cleanup rate limiters every 5 minutes
setInterval(() => {
  searchRateLimiter.cleanup();
  transcriptRateLimiter.cleanup();
}, 5 * 60 * 1000);