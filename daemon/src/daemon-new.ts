/**
 * VoiceRewind Daemon - Refactored Architecture
 * 
 * Main entry point that orchestrates all services and handles the application lifecycle.
 */
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { validateConfig, logConfig, cacheConfig, serverConfig } from './config/index.js';
import { CacheService } from './services/CacheService.js';
import { AudioService } from './services/AudioService.js';
import { ElevenLabsService } from './services/ElevenLabsService.js';
import { createRoutes } from './routes/index.js';
import { WebSocketHandler } from './websocket/index.js';
import type { IntentMessage } from './types/index.js';

class VoiceRewindDaemon {
  private app: express.Application;
  private server: any;
  private wsHandler: WebSocketHandler | null = null;

  constructor() {
    this.app = express();
    this.setupExpress();
    this.server = createServer(this.app);
    this.wsHandler = new WebSocketHandler(this.server);
  }

  /**
   * Sets up Express application middleware and routes
   */
  private setupExpress(): void {
    // Basic middleware
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // Static media serving
    this.app.use('/media', express.static(cacheConfig.mediaDir));

    // API routes
    this.app.use('/', createRoutes());

    // CORS for all routes
    this.app.use((_req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-tool-secret');
      res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      next();
    });

    // Simulation endpoint for testing intents
    this.app.post('/simulate', (req, res) => {
      try {
        const message = req.body as IntentMessage;
        if (!message || !message.intent) {
          return res.status(400).json({ error: 'Invalid intent message' });
        }

        this.broadcast(message);
        res.json({ ok: true, message: 'Intent broadcasted' });
      } catch (error) {
        res.status(500).json({ 
          error: 'Simulation failed', 
          details: (error as Error).message 
        });
      }
    });

    // Global error handler
    this.app.use((error: Error, _req: any, res: any, _next: any) => {
      console.error('[Daemon] Unhandled error:', error);
      res.status(500).json({
        error: 'Internal server error',
        details: error.message
      });
    });
  }

  /**
   * Starts the daemon server
   */
  async start(): Promise<void> {
    try {
      // Validate configuration
      validateConfig();
      
      // Initialize cache directories
      CacheService.ensureDirectories();
      
      // Start HTTP server
      await new Promise<void>((resolve, reject) => {
        this.server.listen(serverConfig.port, '127.0.0.1', (error?: Error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });

      console.log('🚀 VoiceRewind Daemon Started');
      console.log(`📡 HTTP+WebSocket server: http://127.0.0.1:${serverConfig.port}`);
      console.log(`📁 Media files: http://127.0.0.1:${serverConfig.port}/media/`);
      
      // Log configuration
      logConfig();

      // Initialize audio pipeline if enabled
      await this.initializeAudioPipeline();

      // Start health check interval
      this.startHealthChecks();

      console.log('✅ Daemon fully initialized and ready');

    } catch (error) {
      console.error('❌ Failed to start daemon:', (error as Error).message);
      process.exit(1);
    }
  }

  /**
   * Initializes the audio processing pipeline
   */
  private async initializeAudioPipeline(): Promise<void> {
    try {
      await AudioService.initializeAudioPipeline((intent, text) => {
        this.handleVoiceCommand(intent, text);
      });
    } catch (error) {
      console.error('[Daemon] Audio pipeline initialization failed:', (error as Error).message);
    }
  }

  /**
   * Handles voice commands from the audio pipeline
   */
  private async handleVoiceCommand(intent: IntentMessage | null, text: string): Promise<void> {
    try {
      // Broadcast listening states
      this.broadcast({ intent: 'begin_listen' });

      if (intent) {
        // Media control command
        console.log(`[Daemon] Voice command: ${intent.intent} (${intent.value})`);
        this.broadcast(intent);
      } else if (text && text.trim()) {
        // Conversational query
        console.log(`[Daemon] Conversational query: "${text}"`);
        
        try {
          const response = await ElevenLabsService.sendConversationalMessage(
            'voice-session',
            text,
            undefined // No video context for voice commands
          );

          console.log(`[Daemon] Agent response: "${response.text.substring(0, 100)}..."`);
          
          if (response.audioUrl) {
            console.log(`[Daemon] Audio available: ${response.audioUrl}`);
            
            // Broadcast agent response to all connected clients
            this.broadcast({
              intent: 'agent_response',
              value: {
                text: response.text,
                audioUrl: response.audioUrl
              }
            });
          }
        } catch (error) {
          console.error('[Daemon] Conversational AI failed:', (error as Error).message);
        }
      } else {
        console.log('[Daemon] No valid voice input detected');
      }

    } catch (error) {
      console.error('[Daemon] Voice command handling failed:', (error as Error).message);
    } finally {
      // Always end listening state
      this.broadcast({ intent: 'end_listen' });
    }
  }

  /**
   * Broadcasts a message to all connected WebSocket clients
   */
  private broadcast(message: IntentMessage): void {
    if (this.wsHandler) {
      this.wsHandler.broadcast(message);
    }
  }

  /**
   * Starts periodic health checks and maintenance
   */
  private startHealthChecks(): void {
    // Ping WebSocket clients every 30 seconds
    setInterval(() => {
      if (this.wsHandler) {
        const connectedClients = this.wsHandler.getConnectedClientCount();
        if (connectedClients > 0) {
          this.wsHandler.pingClients();
        }
      }
    }, 30000);

    // Log system status every 5 minutes
    setInterval(() => {
      this.logSystemStatus();
    }, 5 * 60 * 1000);
  }

  /**
   * Logs current system status
   */
  private logSystemStatus(): void {
    const wsStats = this.wsHandler?.getStats();
    const cacheStats = CacheService.getCacheStats();
    const audioStatus = AudioService.getAudioStatus();

    console.log('📊 System Status:');
    console.log(`  WebSocket Clients: ${wsStats?.connectedClients ?? 0} connected`);
    console.log(`  Cache: ${cacheStats.transcriptCount} transcripts, ${cacheStats.embeddingCount} embeddings, ${cacheStats.mediaCount} media files`);
    console.log(`  Audio: ${audioStatus.enabled ? 'Enabled' : 'Disabled'} (${audioStatus.wakeKeyword})`);
  }

  /**
   * Gracefully shuts down the daemon
   */
  async shutdown(): Promise<void> {
    console.log('[Daemon] Shutting down gracefully...');

    try {
      // Close WebSocket server
      if (this.wsHandler) {
        await this.wsHandler.close();
      }

      // Close HTTP server
      await new Promise<void>((resolve) => {
        this.server.close(() => {
          resolve();
        });
      });

      console.log('[Daemon] Shutdown complete');
    } catch (error) {
      console.error('[Daemon] Shutdown error:', (error as Error).message);
    }
  }
}

// Create and start daemon instance
const daemon = new VoiceRewindDaemon();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[Daemon] Received SIGINT, shutting down...');
  await daemon.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[Daemon] Received SIGTERM, shutting down...');
  await daemon.shutdown();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('[Daemon] Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Daemon] Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the daemon
daemon.start().catch((error) => {
  console.error('[Daemon] Fatal startup error:', error);
  process.exit(1);
});