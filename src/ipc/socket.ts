import { Server } from "bun";
import { unlink } from "fs/promises";
import { existsSync, writeFileSync, readFileSync } from "fs";
import { dirname } from "path";
import { mkdirSync } from "fs";
import {
  IPCMessage,
  IPCResponse,
  deserializeIPCMessage,
  serializeIPCResponse,
  createErrorResponse,
  validateIPCMessage
} from "../types/index.js";

/**
 * Connection pool for managing WebSocket connections efficiently
 */
class ConnectionPool {
  private connections = new Map<string, {
    ws: any;
    lastActivity: number;
    messageCount: number;
  }>();
  private readonly maxConnections: number;
  private readonly connectionTimeout: number;
  private cleanupInterval: Timer | null = null;

  constructor(maxConnections: number = 100, connectionTimeout: number = 300000) { // 5 minutes
    this.maxConnections = maxConnections;
    this.connectionTimeout = connectionTimeout;
    this.startCleanup();
  }

  addConnection(id: string, ws: any): void {
    // Remove oldest connection if at capacity
    if (this.connections.size >= this.maxConnections) {
      this.evictOldestConnection();
    }

    this.connections.set(id, {
      ws,
      lastActivity: Date.now(),
      messageCount: 0
    });
  }

  updateActivity(id: string): void {
    const conn = this.connections.get(id);
    if (conn) {
      conn.lastActivity = Date.now();
      conn.messageCount++;
    }
  }

  removeConnection(id: string): void {
    this.connections.delete(id);
  }

  getConnection(id: string) {
    return this.connections.get(id);
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  getStats() {
    const now = Date.now();
    const connections = Array.from(this.connections.values());
    
    return {
      total: connections.length,
      active: connections.filter(c => now - c.lastActivity < 60000).length, // Active in last minute
      totalMessages: connections.reduce((sum, c) => sum + c.messageCount, 0),
      avgMessagesPerConnection: connections.length > 0 
        ? connections.reduce((sum, c) => sum + c.messageCount, 0) / connections.length 
        : 0
    };
  }

  private evictOldestConnection(): void {
    let oldestId: string | null = null;
    let oldestTime = Date.now();

    for (const [id, conn] of this.connections.entries()) {
      if (conn.lastActivity < oldestTime) {
        oldestTime = conn.lastActivity;
        oldestId = id;
      }
    }

    if (oldestId) {
      const conn = this.connections.get(oldestId);
      if (conn) {
        try {
          conn.ws.close();
        } catch (error) {
          // Ignore close errors
        }
        this.connections.delete(oldestId);
      }
    }
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleConnections();
    }, 60000); // Cleanup every minute
  }

  private cleanupStaleConnections(): void {
    const now = Date.now();
    const staleConnections: string[] = [];

    for (const [id, conn] of this.connections.entries()) {
      if (now - conn.lastActivity > this.connectionTimeout) {
        staleConnections.push(id);
      }
    }

    for (const id of staleConnections) {
      const conn = this.connections.get(id);
      if (conn) {
        try {
          conn.ws.close();
        } catch (error) {
          // Ignore close errors
        }
        this.connections.delete(id);
      }
    }
  }

  cleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Close all connections
    for (const [id, conn] of this.connections.entries()) {
      try {
        conn.ws.close();
      } catch (error) {
        // Ignore close errors
      }
    }
    this.connections.clear();
  }
}

/**
 * IPC Server for daemon-side communication using TCP with connection pooling
 */
export class IPCServer {
  private server: Server | null = null;
  private socketPath: string;
  private port: number = 0;
  private messageHandlers: Map<string, (message: IPCMessage) => Promise<IPCResponse>> = new Map();
  private connectionPool: ConnectionPool;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
    this.connectionPool = new ConnectionPool();
  }

  /**
   * Register a command handler
   */
  registerHandler(command: string, handler: (message: IPCMessage) => Promise<IPCResponse>): void {
    this.messageHandlers.set(command, handler);
  }

  /**
   * Start the IPC server
   */
  async start(): Promise<void> {
    // Ensure socket directory exists
    const socketDir = dirname(this.socketPath);
    if (!existsSync(socketDir)) {
      mkdirSync(socketDir, { recursive: true });
    }

    // Remove existing port file if it exists
    if (existsSync(this.socketPath)) {
      await unlink(this.socketPath);
    }

    this.server = Bun.serve({
      port: 0, // Let system assign port
      fetch: (req, server) => {
        // Upgrade to WebSocket for IPC communication
        if (server.upgrade(req)) {
          return; // do not return a Response
        }
        return new Response("IPC Server", { status: 426 });
      },
      websocket: {
        message: async (ws, message) => {
          let messageId = 'unknown';
          const connectionId = this.getConnectionId(ws);
          
          try {
            // Update connection activity
            this.connectionPool.updateActivity(connectionId);
            
            const messageStr = message.toString();
            const ipcMessage = deserializeIPCMessage(messageStr);
            messageId = ipcMessage.id;
            
            const handler = this.messageHandlers.get(ipcMessage.command);
            if (!handler) {
              const errorResponse = createErrorResponse(
                ipcMessage.id,
                `Unknown command: ${ipcMessage.command}`
              );
              ws.send(serializeIPCResponse(errorResponse));
              return;
            }

            try {
              const response = await handler(ipcMessage);
              ws.send(serializeIPCResponse(response));
            } catch (handlerError) {
              // Handler threw an error
              const errorMessage = handlerError instanceof Error ? handlerError.message : 'Unknown handler error';
              const errorResponse = createErrorResponse(ipcMessage.id, errorMessage);
              ws.send(serializeIPCResponse(errorResponse));
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            // If we can't parse the message, we can't get the ID, so use what we have
            const errorResponse = createErrorResponse(messageId, `Message processing error: ${errorMessage}`);
            ws.send(serializeIPCResponse(errorResponse));
          }
        },
        open: (ws) => {
          const connectionId = this.getConnectionId(ws);
          this.connectionPool.addConnection(connectionId, ws);
        },
        close: (ws) => {
          const connectionId = this.getConnectionId(ws);
          this.connectionPool.removeConnection(connectionId);
        },
        error: (ws, error) => {
          console.error('WebSocket error:', error);
          const connectionId = this.getConnectionId(ws);
          this.connectionPool.removeConnection(connectionId);
        }
      }
    });

    this.port = this.server.port;
    
    // Write port to file for client discovery
    writeFileSync(this.socketPath, this.port.toString());

    console.log(`IPC Server listening on port ${this.port}`);
  }

  /**
   * Stop the IPC server
   */
  async stop(): Promise<void> {
    if (this.server) {
      // Clean up connection pool
      this.connectionPool.cleanup();

      this.server.stop();
      this.server = null;
    }

    // Clean up port file
    if (existsSync(this.socketPath)) {
      await unlink(this.socketPath);
    }
  }

  /**
   * Get the number of active connections
   */
  getConnectionCount(): number {
    return this.connectionPool.getConnectionCount();
  }

  /**
   * Get connection statistics
   */
  getConnectionStats() {
    return this.connectionPool.getStats();
  }

  /**
   * Generate a unique connection ID for a WebSocket
   */
  private getConnectionId(ws: any): string {
    // Use a combination of timestamp and random number for unique ID
    if (!ws._connectionId) {
      ws._connectionId = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    return ws._connectionId;
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * Get the server port
   */
  getPort(): number {
    return this.port;
  }
}

/**
 * IPC Client for CLI-side communication using WebSocket
 */
export class IPCClient {
  private socketPath: string;
  private ws: WebSocket | null = null;
  private pendingRequests: Map<string, {
    resolve: (response: IPCResponse) => void;
    reject: (error: Error) => void;
    timeout: Timer;
  }> = new Map();
  private connectionPromise: Promise<void> | null = null;
  private isConnected = false;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  /**
   * Connect to the IPC server
   */
  async connect(timeoutMs: number = 5000): Promise<void> {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Connection timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        // Read port from file
        if (!existsSync(this.socketPath)) {
          clearTimeout(timeout);
          reject(new Error('IPC server not running'));
          return;
        }

        const port = parseInt(readFileSync(this.socketPath, 'utf8'));
        this.ws = new WebSocket(`ws://localhost:${port}`);

        this.ws.onopen = () => {
          clearTimeout(timeout);
          this.isConnected = true;
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const response = JSON.parse(event.data) as IPCResponse;
            const pending = this.pendingRequests.get(response.id);
            if (pending) {
              clearTimeout(pending.timeout);
              this.pendingRequests.delete(response.id);
              pending.resolve(response);
            }
          } catch (error) {
            console.error('Failed to parse IPC response:', error);
          }
        };

        this.ws.onerror = (error) => {
          clearTimeout(timeout);
          this.isConnected = false;
          reject(new Error(`WebSocket error: ${error}`));
        };

        this.ws.onclose = () => {
          this.isConnected = false;
          this.connectionPromise = null;
          // Reject all pending requests
          for (const [id, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Connection closed'));
          }
          this.pendingRequests.clear();
        };
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });

    return this.connectionPromise;
  }

  /**
   * Send a message and wait for response
   */
  async sendMessage(message: IPCMessage, timeoutMs: number = 10000): Promise<IPCResponse> {
    if (!this.isConnected || !this.ws) {
      throw new Error('Not connected to IPC server');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(message.id);
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(message.id, {
        resolve,
        reject,
        timeout
      });

      try {
        const messageStr = JSON.stringify(message);
        this.ws!.send(messageStr);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(message.id);
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the IPC server
   */
  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.connectionPromise = null;
  }

  /**
   * Check if client is connected
   */
  isConnectedToServer(): boolean {
    return this.isConnected;
  }
}

/**
 * Utility function to get default socket path
 */
export function getDefaultSocketPath(): string {
  // Check for custom socket path in environment variable
  if (process.env.BUN_PM_SOCKET) {
    return process.env.BUN_PM_SOCKET;
  }
  
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return `${homeDir}/.bun-pm/daemon.sock`;
}

/**
 * Check if daemon is running by testing socket connection
 */
export async function isDaemonRunning(socketPath?: string): Promise<boolean> {
  const path = socketPath || getDefaultSocketPath();
  
  if (!existsSync(path)) {
    return false;
  }

  const client = new IPCClient(path);
  try {
    await client.connect(1000); // Short timeout for quick check
    await client.disconnect();
    return true;
  } catch {
    return false;
  }
}

/**
 * Error types for IPC operations
 */
export class IPCError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'IPCError';
  }
}

export class IPCTimeoutError extends IPCError {
  constructor(message: string) {
    super(message, 'TIMEOUT');
    this.name = 'IPCTimeoutError';
  }
}

export class IPCConnectionError extends IPCError {
  constructor(message: string) {
    super(message, 'CONNECTION');
    this.name = 'IPCConnectionError';
  }
}