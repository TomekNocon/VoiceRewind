/**
 * WebSocket handling for real-time communication with browser extensions
 */
import { WebSocketServer } from 'ws';
import type { Server } from 'http';
import type { IntentMessage } from '../types/index.js';

export class WebSocketHandler {
  private wss: WebSocketServer;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server });
    this.setupWebSocketServer();
  }

  /**
   * Sets up WebSocket server event handlers
   */
  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws, request) => {
      const clientIp = request.socket.remoteAddress;
      console.log(`[WebSocket] New connection from ${clientIp}`);

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          console.log('[WebSocket] Received message:', message);
          
          // Handle any incoming messages from clients if needed
          // Currently, the daemon primarily broadcasts to clients
          
        } catch (error) {
          console.warn('[WebSocket] Invalid message format:', (error as Error).message);
        }
      });

      ws.on('close', (code, reason) => {
        console.log(`[WebSocket] Client disconnected: ${code} ${reason?.toString()}`);
      });

      ws.on('error', (error) => {
        console.error('[WebSocket] Client error:', error);
      });

      // Send initial connection confirmation
      try {
        ws.send(JSON.stringify({ 
          type: 'connection', 
          status: 'connected',
          timestamp: new Date().toISOString()
        }));
      } catch (error) {
        console.warn('[WebSocket] Failed to send connection confirmation:', error);
      }
    });

    this.wss.on('error', (error) => {
      console.error('[WebSocket] Server error:', error);
    });

    console.log('[WebSocket] Server initialized');
  }

  /**
   * Broadcasts a message to all connected clients
   */
  broadcast(message: IntentMessage): void {
    const payload = JSON.stringify(message);
    let sentCount = 0;
    let errorCount = 0;

    for (const client of this.wss.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        try {
          client.send(payload);
          sentCount++;
        } catch (error) {
          errorCount++;
          console.warn('[WebSocket] Failed to send to client:', (error as Error).message);
        }
      }
    }

    if (sentCount > 0 || errorCount > 0) {
      console.log(`[WebSocket] Broadcast ${message.intent} -> ${sentCount} client(s) (${errorCount} errors)`);
    }
  }

  /**
   * Broadcasts to specific client by some criteria (if needed in future)
   */
  broadcastToClient(message: IntentMessage, clientFilter?: (ws: any) => boolean): void {
    const payload = JSON.stringify(message);
    let sentCount = 0;

    for (const client of this.wss.clients) {
      if (client.readyState === 1) {
        if (!clientFilter || clientFilter(client)) {
          try {
            client.send(payload);
            sentCount++;
          } catch (error) {
            console.warn('[WebSocket] Failed to send to filtered client:', (error as Error).message);
          }
        }
      }
    }

    console.log(`[WebSocket] Filtered broadcast ${message.intent} -> ${sentCount} client(s)`);
  }

  /**
   * Gets the number of connected clients
   */
  getConnectedClientCount(): number {
    let count = 0;
    for (const client of this.wss.clients) {
      if (client.readyState === 1) {
        count++;
      }
    }
    return count;
  }

  /**
   * Gets WebSocket server statistics
   */
  getStats(): {
    totalClients: number;
    connectedClients: number;
    connectingClients: number;
    closingClients: number;
    closedClients: number;
  } {
    const stats = {
      totalClients: this.wss.clients.size,
      connectedClients: 0,
      connectingClients: 0,
      closingClients: 0,
      closedClients: 0
    };

    for (const client of this.wss.clients) {
      switch (client.readyState) {
        case 0: // CONNECTING
          stats.connectingClients++;
          break;
        case 1: // OPEN
          stats.connectedClients++;
          break;
        case 2: // CLOSING
          stats.closingClients++;
          break;
        case 3: // CLOSED
          stats.closedClients++;
          break;
      }
    }

    return stats;
  }

  /**
   * Closes the WebSocket server
   */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.close((error) => {
        if (error) {
          reject(error);
        } else {
          console.log('[WebSocket] Server closed');
          resolve();
        }
      });
    });
  }

  /**
   * Pings all connected clients (for health checking)
   */
  pingClients(): void {
    let pingCount = 0;
    
    for (const client of this.wss.clients) {
      if (client.readyState === 1) {
        try {
          client.ping();
          pingCount++;
        } catch (error) {
          console.warn('[WebSocket] Failed to ping client:', error);
        }
      }
    }

    if (pingCount > 0) {
      console.log(`[WebSocket] Pinged ${pingCount} client(s)`);
    }
  }
}