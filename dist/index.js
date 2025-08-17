#!/usr/bin/env bun
// @bun

// src/ipc/socket.ts
import { unlink } from "fs/promises";
import { existsSync, writeFileSync, readFileSync } from "fs";
import { dirname } from "path";
import { mkdirSync } from "fs";

// src/types/index.ts
function createProcessConfig(partial) {
  return {
    cwd: process.cwd(),
    env: {},
    instances: 1,
    autorestart: true,
    maxRestarts: 10,
    ...partial
  };
}
function validateIPCMessage(message) {
  const errors = [];
  if (!message.id || typeof message.id !== "string") {
    errors.push("id is required and must be a string");
  }
  if (!message.command || typeof message.command !== "string") {
    errors.push("command is required and must be a string");
  }
  return {
    isValid: errors.length === 0,
    errors
  };
}
function deserializeIPCMessage(data) {
  try {
    const parsed = JSON.parse(data);
    const validation = validateIPCMessage(parsed);
    if (!validation.isValid) {
      throw new Error(`Invalid IPC message: ${validation.errors.join(", ")}`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in IPC message: ${error.message}`);
    }
    throw error;
  }
}
function serializeIPCResponse(response) {
  try {
    return JSON.stringify(response);
  } catch (error) {
    throw new Error(`Failed to serialize IPC response: ${error}`);
  }
}
function createIPCMessage(command, payload = {}) {
  return {
    id: crypto.randomUUID(),
    command,
    payload
  };
}
function createErrorResponse(id, error) {
  return {
    id,
    success: false,
    error
  };
}

// src/ipc/socket.ts
class ConnectionPool {
  connections = new Map;
  maxConnections;
  connectionTimeout;
  cleanupInterval = null;
  constructor(maxConnections = 100, connectionTimeout = 300000) {
    this.maxConnections = maxConnections;
    this.connectionTimeout = connectionTimeout;
    this.startCleanup();
  }
  addConnection(id, ws) {
    if (this.connections.size >= this.maxConnections) {
      this.evictOldestConnection();
    }
    this.connections.set(id, {
      ws,
      lastActivity: Date.now(),
      messageCount: 0
    });
  }
  updateActivity(id) {
    const conn = this.connections.get(id);
    if (conn) {
      conn.lastActivity = Date.now();
      conn.messageCount++;
    }
  }
  removeConnection(id) {
    this.connections.delete(id);
  }
  getConnection(id) {
    return this.connections.get(id);
  }
  getConnectionCount() {
    return this.connections.size;
  }
  getStats() {
    const now = Date.now();
    const connections = Array.from(this.connections.values());
    return {
      total: connections.length,
      active: connections.filter((c) => now - c.lastActivity < 60000).length,
      totalMessages: connections.reduce((sum, c) => sum + c.messageCount, 0),
      avgMessagesPerConnection: connections.length > 0 ? connections.reduce((sum, c) => sum + c.messageCount, 0) / connections.length : 0
    };
  }
  evictOldestConnection() {
    let oldestId = null;
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
        } catch (error) {}
        this.connections.delete(oldestId);
      }
    }
  }
  startCleanup() {
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleConnections();
    }, 60000);
  }
  cleanupStaleConnections() {
    const now = Date.now();
    const staleConnections = [];
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
        } catch (error) {}
        this.connections.delete(id);
      }
    }
  }
  cleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    for (const [id, conn] of this.connections.entries()) {
      try {
        conn.ws.close();
      } catch (error) {}
    }
    this.connections.clear();
  }
}

class IPCServer {
  server = null;
  socketPath;
  port = 0;
  messageHandlers = new Map;
  connectionPool;
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.connectionPool = new ConnectionPool;
  }
  registerHandler(command, handler) {
    this.messageHandlers.set(command, handler);
  }
  async start() {
    const socketDir = dirname(this.socketPath);
    if (!existsSync(socketDir)) {
      mkdirSync(socketDir, { recursive: true });
    }
    if (existsSync(this.socketPath)) {
      await unlink(this.socketPath);
    }
    this.server = Bun.serve({
      port: 0,
      fetch: (req, server) => {
        if (server.upgrade(req)) {
          return;
        }
        return new Response("IPC Server", { status: 426 });
      },
      websocket: {
        message: async (ws, message) => {
          let messageId = "unknown";
          const connectionId = this.getConnectionId(ws);
          try {
            this.connectionPool.updateActivity(connectionId);
            const messageStr = message.toString();
            const ipcMessage = deserializeIPCMessage(messageStr);
            messageId = ipcMessage.id;
            const handler = this.messageHandlers.get(ipcMessage.command);
            if (!handler) {
              const errorResponse = createErrorResponse(ipcMessage.id, `Unknown command: ${ipcMessage.command}`);
              ws.send(serializeIPCResponse(errorResponse));
              return;
            }
            try {
              const response = await handler(ipcMessage);
              ws.send(serializeIPCResponse(response));
            } catch (handlerError) {
              const errorMessage = handlerError instanceof Error ? handlerError.message : "Unknown handler error";
              const errorResponse = createErrorResponse(ipcMessage.id, errorMessage);
              ws.send(serializeIPCResponse(errorResponse));
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
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
          console.error("WebSocket error:", error);
          const connectionId = this.getConnectionId(ws);
          this.connectionPool.removeConnection(connectionId);
        }
      }
    });
    this.port = this.server.port;
    writeFileSync(this.socketPath, this.port.toString());
    console.log(`IPC Server listening on port ${this.port}`);
  }
  async stop() {
    if (this.server) {
      this.connectionPool.cleanup();
      this.server.stop();
      this.server = null;
    }
    if (existsSync(this.socketPath)) {
      await unlink(this.socketPath);
    }
  }
  getConnectionCount() {
    return this.connectionPool.getConnectionCount();
  }
  getConnectionStats() {
    return this.connectionPool.getStats();
  }
  getConnectionId(ws) {
    if (!ws._connectionId) {
      ws._connectionId = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    return ws._connectionId;
  }
  isRunning() {
    return this.server !== null;
  }
  getPort() {
    return this.port;
  }
}

class IPCClient {
  socketPath;
  ws = null;
  pendingRequests = new Map;
  connectionPromise = null;
  isConnected = false;
  constructor(socketPath) {
    this.socketPath = socketPath;
  }
  async connect(timeoutMs = 5000) {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }
    this.connectionPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Connection timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      try {
        if (!existsSync(this.socketPath)) {
          clearTimeout(timeout);
          reject(new Error("IPC server not running"));
          return;
        }
        const port = parseInt(readFileSync(this.socketPath, "utf8"));
        this.ws = new WebSocket(`ws://localhost:${port}`);
        this.ws.onopen = () => {
          clearTimeout(timeout);
          this.isConnected = true;
          resolve();
        };
        this.ws.onmessage = (event) => {
          try {
            const response = JSON.parse(event.data);
            const pending = this.pendingRequests.get(response.id);
            if (pending) {
              clearTimeout(pending.timeout);
              this.pendingRequests.delete(response.id);
              pending.resolve(response);
            }
          } catch (error) {
            console.error("Failed to parse IPC response:", error);
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
          for (const [id, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(new Error("Connection closed"));
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
  async sendMessage(message, timeoutMs = 1e4) {
    if (!this.isConnected || !this.ws) {
      throw new Error("Not connected to IPC server");
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
        this.ws.send(messageStr);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(message.id);
        reject(error);
      }
    });
  }
  async disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.connectionPromise = null;
  }
  isConnectedToServer() {
    return this.isConnected;
  }
}
function getDefaultSocketPath() {
  if (process.env.BUN_PM_SOCKET) {
    return process.env.BUN_PM_SOCKET;
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return `${homeDir}/.bun-pm/daemon.sock`;
}
async function isDaemonRunning(socketPath) {
  const path = socketPath || getDefaultSocketPath();
  if (!existsSync(path)) {
    return false;
  }
  const client = new IPCClient(path);
  try {
    await client.connect(1000);
    await client.disconnect();
    return true;
  } catch {
    return false;
  }
}
// src/core/daemon-manager.ts
import { resolve, dirname as dirname2 } from "path";
import { existsSync as existsSync2, mkdirSync as mkdirSync2 } from "fs";
import { writeFile, readFile, unlink as unlink2 } from "fs/promises";
class DaemonManager {
  pidFilePath;
  socketPath;
  constructor(socketPath) {
    this.socketPath = socketPath || getDefaultSocketPath();
    this.pidFilePath = this.getPidFilePath();
  }
  getPidFilePath() {
    const daemonDir = dirname2(this.socketPath);
    return resolve(daemonDir, "daemon.pid");
  }
  ensureDaemonDirectory() {
    const daemonDir = dirname2(this.socketPath);
    if (!existsSync2(daemonDir)) {
      mkdirSync2(daemonDir, { recursive: true });
    }
  }
  async writePidFile(pid) {
    this.ensureDaemonDirectory();
    const daemonInfo = {
      pid,
      startTime: new Date,
      socketPath: this.socketPath,
      version: process.env.npm_package_version || "1.0.0"
    };
    await writeFile(this.pidFilePath, JSON.stringify(daemonInfo, null, 2));
  }
  async readPidFile() {
    try {
      if (!existsSync2(this.pidFilePath)) {
        return null;
      }
      const content = await readFile(this.pidFilePath, "utf8");
      const daemonInfo = JSON.parse(content);
      daemonInfo.startTime = new Date(daemonInfo.startTime);
      return daemonInfo;
    } catch (error) {
      return null;
    }
  }
  async removePidFile() {
    try {
      if (existsSync2(this.pidFilePath)) {
        await unlink2(this.pidFilePath);
      }
    } catch (error) {}
  }
  async isDaemonProcessRunning(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }
  async getDaemonStatus() {
    const daemonInfo = await this.readPidFile();
    const pidFileExists = daemonInfo !== null;
    let processRunning = false;
    if (daemonInfo) {
      processRunning = await this.isDaemonProcessRunning(daemonInfo.pid);
    }
    const socketResponding = await isDaemonRunning(this.socketPath);
    let healthStatus = "unknown";
    if (pidFileExists && processRunning && socketResponding) {
      healthStatus = "healthy";
    } else if (pidFileExists || processRunning || socketResponding) {
      healthStatus = "unhealthy";
    }
    return {
      isRunning: socketResponding,
      pidFileExists,
      processRunning,
      socketResponding,
      daemonInfo,
      healthStatus
    };
  }
  async cleanupStaleState() {
    const status = await this.getDaemonStatus();
    if (status.pidFileExists && (!status.processRunning || !status.socketResponding)) {
      console.log("Cleaning up stale daemon state...");
      await this.removePidFile();
      try {
        if (existsSync2(this.socketPath)) {
          await unlink2(this.socketPath);
        }
      } catch (error) {}
    }
  }
  async startDaemon() {
    const status = await this.getDaemonStatus();
    if (status.healthStatus === "healthy") {
      return;
    }
    await this.cleanupStaleState();
    console.log("Starting daemon...");
    const startupScript = `
      const { ProcessDaemon } = await import('${import.meta.resolve("../daemon/daemon.js")}');
      const { DaemonManager } = await import('${import.meta.resolve("./daemon-manager.js")}');
      
      const daemon = new ProcessDaemon('${this.socketPath}');
      const daemonManager = new DaemonManager('${this.socketPath}');
      
      // Write PID file
      await daemonManager.writePidFile(process.pid);
      
      // Start daemon
      await daemon.start();
      
      // Set up graceful shutdown handlers
      const shutdown = async (signal) => {
        console.log(\`Received \${signal}, shutting down daemon...\`);
        try {
          await daemon.stop();
          await daemonManager.removePidFile();
        } catch (error) {
          console.error('Error during shutdown:', error);
        }
        process.exit(0);
      };
      
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGHUP', () => shutdown('SIGHUP'));
      
      // Handle uncaught exceptions
      process.on('uncaughtException', async (error) => {
        console.error('Uncaught exception in daemon:', error);
        try {
          await daemon.stop();
          await daemonManager.removePidFile();
        } catch (cleanupError) {
          console.error('Error during cleanup:', cleanupError);
        }
        process.exit(1);
      });
      
      // Keep process running
      console.log('Daemon started successfully');
    `;
    const daemonProcess = Bun.spawn({
      cmd: [process.execPath, "-e", startupScript],
      stdio: ["ignore", "ignore", "ignore"],
      detached: true
    });
    daemonProcess.unref();
    const maxWaitTime = 5000;
    const checkInterval = 200;
    const maxAttempts = maxWaitTime / checkInterval;
    for (let attempt = 0;attempt < maxAttempts; attempt++) {
      await new Promise((resolve2) => setTimeout(resolve2, checkInterval));
      const currentStatus = await this.getDaemonStatus();
      if (currentStatus.healthStatus === "healthy") {
        console.log("\u2713 Daemon started successfully");
        return;
      }
    }
    await this.cleanupStaleState();
    throw new Error("Failed to start daemon - timeout waiting for healthy status");
  }
  async stopDaemon() {
    const status = await this.getDaemonStatus();
    if (!status.isRunning) {
      console.log("Daemon is not running");
      await this.cleanupStaleState();
      return;
    }
    if (status.daemonInfo) {
      try {
        process.kill(status.daemonInfo.pid, "SIGTERM");
        const maxWaitTime = 5000;
        const checkInterval = 200;
        const maxAttempts = maxWaitTime / checkInterval;
        for (let attempt = 0;attempt < maxAttempts; attempt++) {
          await new Promise((resolve2) => setTimeout(resolve2, checkInterval));
          const currentStatus = await this.getDaemonStatus();
          if (!currentStatus.isRunning) {
            console.log("\u2713 Daemon stopped successfully");
            return;
          }
        }
        console.log("Graceful shutdown timeout, force killing daemon...");
        process.kill(status.daemonInfo.pid, "SIGKILL");
        await new Promise((resolve2) => setTimeout(resolve2, 1000));
        await this.cleanupStaleState();
      } catch (error) {
        await this.cleanupStaleState();
      }
    }
  }
  async restartDaemon() {
    console.log("Restarting daemon...");
    await this.stopDaemon();
    await this.startDaemon();
  }
  async ensureDaemonRunning() {
    const status = await this.getDaemonStatus();
    switch (status.healthStatus) {
      case "healthy":
        return;
      case "unhealthy":
        console.log("Daemon state is unhealthy, restarting...");
        await this.cleanupStaleState();
        await this.startDaemon();
        break;
      case "unknown":
        await this.startDaemon();
        break;
    }
  }
}

// src/core/error-handler.ts
class ProcessManagerError extends Error {
  code;
  category;
  severity;
  timestamp;
  context;
  recoverable;
  constructor(message, code, category, severity = "error", recoverable = false, context) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.category = category;
    this.severity = severity;
    this.timestamp = new Date;
    this.context = context;
    this.recoverable = recoverable;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
  getUserMessage() {
    return this.message;
  }
  getDetailedInfo() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      category: this.category,
      severity: this.severity,
      timestamp: this.timestamp,
      context: this.context,
      recoverable: this.recoverable,
      stack: this.stack
    };
  }
}

class ProcessError extends ProcessManagerError {
  constructor(message, code, severity = "error", recoverable = true, context) {
    super(message, code, "process", severity, recoverable, context);
  }
}
class ProcessCrashError extends ProcessError {
  constructor(processId, exitCode, signal, context) {
    const signalInfo = signal ? ` (signal: ${signal})` : "";
    super(`Process '${processId}' crashed with exit code ${exitCode}${signalInfo}`, "PROCESS_CRASHED", "warning", true, { processId, exitCode, signal, ...context });
  }
  getUserMessage() {
    const processId = this.context?.processId || "unknown";
    const exitCode = this.context?.exitCode || "unknown";
    return `Process '${processId}' stopped unexpectedly (exit code: ${exitCode})`;
  }
}
class ProcessMemoryLimitError extends ProcessError {
  constructor(processId, currentMemory, memoryLimit, context) {
    super(`Process '${processId}' exceeded memory limit (${currentMemory} > ${memoryLimit} bytes)`, "PROCESS_MEMORY_LIMIT_EXCEEDED", "warning", true, { processId, currentMemory, memoryLimit, ...context });
  }
  getUserMessage() {
    const processId = this.context?.processId || "unknown";
    const currentMemory = this.context?.currentMemory || 0;
    const memoryLimit = this.context?.memoryLimit || 0;
    const currentMB = Math.round(currentMemory / 1024 / 1024);
    const limitMB = Math.round(memoryLimit / 1024 / 1024);
    return `Process '${processId}' is using too much memory (${currentMB}MB > ${limitMB}MB limit). Restarting to free memory.`;
  }
}
class IPCError2 extends ProcessManagerError {
  constructor(message, code, severity = "error", recoverable = true, context) {
    super(message, code, "ipc", severity, recoverable, context);
  }
}

class IPCConnectionError2 extends IPCError2 {
  constructor(socketPath, reason, context) {
    const reasonText = reason ? `: ${reason}` : "";
    super(`Failed to connect to daemon at ${socketPath}${reasonText}`, "IPC_CONNECTION_FAILED", "error", true, { socketPath, reason, ...context });
  }
  getUserMessage() {
    return "Unable to connect to the process daemon. The daemon may not be running or there may be a permission issue.";
  }
}

class IPCTimeoutError2 extends IPCError2 {
  constructor(command, timeoutMs, context) {
    super(`IPC command '${command}' timed out after ${timeoutMs}ms`, "IPC_TIMEOUT", "warning", true, { command, timeoutMs, ...context });
  }
  getUserMessage() {
    const command = this.context?.command || "unknown";
    return `Command '${command}' took too long to complete. The daemon may be overloaded.`;
  }
}

class FileSystemError extends ProcessManagerError {
  constructor(message, code, severity = "error", recoverable = false, context) {
    super(message, code, "filesystem", severity, recoverable, context);
  }
}

class FileNotFoundError extends FileSystemError {
  constructor(filePath, context) {
    super(`File not found: ${filePath}`, "FILE_NOT_FOUND", "error", false, { filePath, ...context });
  }
  getUserMessage() {
    const filePath = this.context?.filePath || "unknown";
    return `File '${filePath}' does not exist. Please check the file path and try again.`;
  }
}

class PermissionDeniedError extends FileSystemError {
  constructor(filePath, operation, context) {
    super(`Permission denied: cannot ${operation} ${filePath}`, "PERMISSION_DENIED", "error", false, { filePath, operation, ...context });
  }
  getUserMessage() {
    const filePath = this.context?.filePath || "unknown";
    const operation = this.context?.operation || "access";
    return `Permission denied: cannot ${operation} '${filePath}'. Please check file permissions.`;
  }
}
class ProcessRestartRecovery {
  name = "process-restart";
  description = "Restart failed processes with exponential backoff";
  canRecover(error) {
    return error instanceof ProcessCrashError || error instanceof ProcessMemoryLimitError;
  }
  async recover(error, processManager) {
    if (!processManager) {
      return {
        success: false,
        message: "Process manager not available for recovery",
        retryable: false
      };
    }
    const processId = error.context?.processId;
    if (!processId) {
      return {
        success: false,
        message: "Process ID not available for recovery",
        retryable: false
      };
    }
    try {
      const restartStats = processManager.getRestartStats(processId);
      if (!restartStats?.canRestart) {
        return {
          success: false,
          message: `Process '${processId}' cannot be restarted (max attempts reached)`,
          retryable: false
        };
      }
      return {
        success: true,
        message: `Process '${processId}' will be restarted automatically`,
        retryable: true,
        context: { processId, restartCount: restartStats.restartCount }
      };
    } catch (recoveryError) {
      return {
        success: false,
        message: `Failed to recover process '${processId}': ${recoveryError}`,
        retryable: true
      };
    }
  }
}

class IPCReconnectionRecovery {
  name = "ipc-reconnection";
  description = "Reconnect to IPC server with exponential backoff";
  canRecover(error) {
    return error instanceof IPCConnectionError2 || error instanceof IPCTimeoutError2;
  }
  async recover(error, ipcClient) {
    if (!ipcClient) {
      return {
        success: false,
        message: "IPC client not available for recovery",
        retryable: false
      };
    }
    try {
      await ipcClient.connect();
      return {
        success: true,
        message: "Successfully reconnected to daemon",
        retryable: false
      };
    } catch (recoveryError) {
      return {
        success: false,
        message: `Failed to reconnect: ${recoveryError}`,
        retryable: true
      };
    }
  }
}

class ErrorHandler {
  recoveryStrategies = [];
  errorLog = [];
  maxLogSize = 1000;
  constructor() {
    this.registerRecoveryStrategy(new ProcessRestartRecovery);
    this.registerRecoveryStrategy(new IPCReconnectionRecovery);
  }
  registerRecoveryStrategy(strategy) {
    this.recoveryStrategies.push(strategy);
  }
  async handleError(error, context) {
    const processError = error instanceof ProcessManagerError ? error : this.convertToProcessManagerError(error);
    this.logError(processError);
    if (processError.recoverable) {
      const recoveryResult = await this.attemptRecovery(processError, context);
      return {
        handled: true,
        recovered: recoveryResult.success,
        message: recoveryResult.message
      };
    }
    return {
      handled: true,
      recovered: false,
      message: processError.getUserMessage()
    };
  }
  convertToProcessManagerError(error) {
    const message = error.message.toLowerCase();
    if (message.includes("enoent") || message.includes("not found")) {
      return new FileNotFoundError(error.message, { originalError: error.message });
    }
    if (message.includes("eacces") || message.includes("permission")) {
      return new PermissionDeniedError(error.message, "access", { originalError: error.message });
    }
    if (message.includes("connection") || message.includes("socket")) {
      return new IPCConnectionError2("unknown", error.message, { originalError: error.message });
    }
    return new ProcessError(error.message, "UNKNOWN_ERROR", "error", false, { originalError: error.message, stack: error.stack });
  }
  logError(error) {
    const errorDetails = error.getDetailedInfo();
    this.errorLog.push(errorDetails);
    if (this.errorLog.length > this.maxLogSize) {
      this.errorLog = this.errorLog.slice(-this.maxLogSize);
    }
    const timestamp = errorDetails.timestamp.toISOString();
    const prefix = `[${timestamp}] [${errorDetails.severity.toUpperCase()}] [${errorDetails.category}]`;
    switch (errorDetails.severity) {
      case "critical":
        console.error(`${prefix} CRITICAL: ${errorDetails.message}`);
        if (errorDetails.context) {
          console.error("Context:", errorDetails.context);
        }
        break;
      case "error":
        console.error(`${prefix} ${errorDetails.message}`);
        break;
      case "warning":
        console.warn(`${prefix} ${errorDetails.message}`);
        break;
      case "info":
        console.log(`${prefix} ${errorDetails.message}`);
        break;
    }
  }
  async attemptRecovery(error, context) {
    for (const strategy of this.recoveryStrategies) {
      if (strategy.canRecover(error)) {
        try {
          const result = await strategy.recover(error, context);
          if (result.success) {
            console.log(`Recovery successful using strategy '${strategy.name}': ${result.message}`);
            return result;
          } else if (!result.retryable) {
            console.error(`Recovery failed using strategy '${strategy.name}': ${result.message}`);
            return result;
          }
        } catch (recoveryError) {
          console.error(`Recovery strategy '${strategy.name}' threw error:`, recoveryError);
        }
      }
    }
    return {
      success: false,
      message: "No recovery strategy available for this error",
      retryable: false
    };
  }
  getErrorHistory(limit) {
    const errors = limit ? this.errorLog.slice(-limit) : this.errorLog;
    return [...errors];
  }
  getErrorStats() {
    const now = new Date;
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const stats = {
      total: this.errorLog.length,
      byCategory: {},
      bySeverity: {},
      recent: 0
    };
    const categories = ["process", "config", "ipc", "filesystem", "validation", "resource", "network", "system"];
    const severities = ["info", "warning", "error", "critical"];
    categories.forEach((cat) => stats.byCategory[cat] = 0);
    severities.forEach((sev) => stats.bySeverity[sev] = 0);
    for (const error of this.errorLog) {
      stats.byCategory[error.category]++;
      stats.bySeverity[error.severity]++;
      if (error.timestamp >= oneHourAgo) {
        stats.recent++;
      }
    }
    return stats;
  }
  clearErrorHistory() {
    this.errorLog = [];
  }
}
var globalErrorHandler = new ErrorHandler;
function createUserFriendlyError(error) {
  if (error instanceof ProcessManagerError) {
    return error.getUserMessage();
  }
  const message = error.message;
  if (message.includes("ENOENT")) {
    return "File or directory not found. Please check the path and try again.";
  }
  if (message.includes("EACCES")) {
    return "Permission denied. Please check file permissions or run with appropriate privileges.";
  }
  if (message.includes("EADDRINUSE")) {
    return "Address already in use. Another process may be using the same port or socket.";
  }
  if (message.includes("ECONNREFUSED")) {
    return "Connection refused. The target service may not be running.";
  }
  return message || "An unknown error occurred";
}

// src/cli/index.ts
import { resolve as resolve2, basename } from "path";
import { existsSync as existsSync3 } from "fs";
async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
      showHelp();
      process.exit(0);
    }
    if (args.includes("--version") || args.includes("-v")) {
      showVersion();
      process.exit(0);
    }
    const command = args[0];
    const commandArgs = args.slice(1);
    switch (command) {
      case "start":
        await handleStart(commandArgs);
        break;
      case "stop":
        await handleStop(commandArgs);
        break;
      case "restart":
        await handleRestart(commandArgs);
        break;
      case "list":
      case "ls":
        await handleList(commandArgs);
        break;
      case "logs":
        await handleLogs(commandArgs);
        break;
      case "scale":
        await handleScale(commandArgs);
        break;
      case "save":
        await handleSave(commandArgs);
        break;
      case "load":
        await handleLoad(commandArgs);
        break;
      case "delete":
      case "del":
        await handleDelete(commandArgs);
        break;
      case "monit":
        await handleMonit(commandArgs);
        break;
      case "show":
        await handleShow(commandArgs);
        break;
      case "errors":
        await handleErrors(commandArgs);
        break;
      case "error-stats":
        await handleErrorStats(commandArgs);
        break;
      case "daemon":
        await handleDaemon(commandArgs);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.error('Run "bun-pm --help" for usage information');
        process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
async function handleStart(args) {
  if (args.length === 0) {
    console.error("Error: Script path or ecosystem file is required");
    console.error("Usage: bun-pm start <script|ecosystem.json> [options]");
    console.error("       bun-pm start ecosystem.json [app-name]");
    process.exit(1);
  }
  const scriptOrConfigPath = args[0];
  if (scriptOrConfigPath.endsWith(".json")) {
    await handleStartFromEcosystem(args);
    return;
  }
  const options = parseCommandOptions(args.slice(1));
  const fullScriptPath = resolve2(process.cwd(), scriptOrConfigPath);
  if (!existsSync3(fullScriptPath)) {
    console.error(`Error: Script file not found: ${scriptOrConfigPath}`);
    process.exit(1);
  }
  const processName = options.name || basename(scriptOrConfigPath, ".ts").replace(/\.(js|ts|mjs)$/, "");
  const processId = `${processName}-${Date.now()}`;
  const config = createProcessConfig({
    id: processId,
    name: processName,
    script: scriptOrConfigPath,
    cwd: options.cwd || process.cwd(),
    env: parseEnvVars(options.env || []),
    instances: options.instances || 1,
    autorestart: options["no-autorestart"] ? false : options.autorestart ?? true,
    memoryLimit: options["memory-limit"]
  });
  await ensureDaemonRunning();
  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    const message = createIPCMessage("start", { config });
    const response = await client.sendMessage(message);
    if (response.success) {
      console.log(`\u2713 Started ${processName} (${processId})`);
      if (config.instances > 1) {
        console.log(`  Instances: ${config.instances}`);
      }
      console.log(`  Script: ${scriptOrConfigPath}`);
      console.log(`  Working directory: ${config.cwd}`);
    } else {
      console.error(`\u2717 Failed to start ${processName}: ${response.error}`);
      process.exit(1);
    }
  } finally {
    await client.disconnect();
  }
}
async function handleStop(args) {
  if (args.length === 0) {
    console.error("Error: Process name or ID is required");
    console.error("Usage: bun-pm stop <name|id>");
    process.exit(1);
  }
  const processIdentifier = args[0];
  await ensureDaemonRunning();
  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    const message = createIPCMessage("stop", { identifier: processIdentifier });
    const response = await client.sendMessage(message);
    if (response.success) {
      console.log(`\u2713 Stopped ${processIdentifier}`);
    } else {
      console.error(`\u2717 Failed to stop ${processIdentifier}: ${response.error}`);
      process.exit(1);
    }
  } finally {
    await client.disconnect();
  }
}
async function handleRestart(args) {
  if (args.length === 0) {
    console.error("Error: Process name or ID is required");
    console.error("Usage: bun-pm restart <name|id>");
    process.exit(1);
  }
  const processIdentifier = args[0];
  await ensureDaemonRunning();
  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    const message = createIPCMessage("restart", { identifier: processIdentifier });
    const response = await client.sendMessage(message);
    if (response.success) {
      console.log(`\u2713 Restarted ${processIdentifier}`);
    } else {
      console.error(`\u2717 Failed to restart ${processIdentifier}: ${response.error}`);
      process.exit(1);
    }
  } finally {
    await client.disconnect();
  }
}
async function handleList(args) {
  await ensureDaemonRunning();
  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    const message = createIPCMessage("list", {});
    const response = await client.sendMessage(message);
    if (response.success) {
      const processes = response.data?.processes || [];
      if (processes.length === 0) {
        console.log("No processes running");
        return;
      }
      displayProcessList(processes);
    } else {
      console.error(`\u2717 Failed to list processes: ${response.error}`);
      process.exit(1);
    }
  } finally {
    await client.disconnect();
  }
}
function displayProcessList(processes) {
  const processInfos = processes.map((proc) => ({
    id: proc.id,
    name: proc.name || proc.id,
    status: formatStatus(proc.status),
    pid: proc.pid || 0,
    uptime: formatUptime(proc.startTime),
    restarts: proc.restartCount || 0,
    memory: proc.memory ? formatMemory(proc.memory) : "N/A"
  }));
  const nameWidth = Math.max(4, ...processInfos.map((p) => p.name.length));
  const statusWidth = Math.max(6, ...processInfos.map((p) => p.status.length));
  const pidWidth = Math.max(3, ...processInfos.map((p) => p.pid.toString().length));
  const uptimeWidth = Math.max(6, ...processInfos.map((p) => p.uptime.length));
  const restartsWidth = Math.max(8, ...processInfos.map((p) => p.restarts.toString().length));
  const memoryWidth = Math.max(6, ...processInfos.map((p) => (p.memory || "N/A").length));
  console.log(padRight("NAME", nameWidth) + " \u2502 " + padRight("STATUS", statusWidth) + " \u2502 " + padLeft("PID", pidWidth) + " \u2502 " + padRight("UPTIME", uptimeWidth) + " \u2502 " + padLeft("RESTARTS", restartsWidth) + " \u2502 " + padLeft("MEMORY", memoryWidth));
  console.log("\u2500".repeat(nameWidth + statusWidth + pidWidth + uptimeWidth + restartsWidth + memoryWidth + 15));
  for (const proc of processInfos) {
    console.log(padRight(proc.name, nameWidth) + " \u2502 " + padRight(proc.status, statusWidth) + " \u2502 " + padLeft(proc.pid.toString(), pidWidth) + " \u2502 " + padRight(proc.uptime, uptimeWidth) + " \u2502 " + padLeft(proc.restarts.toString(), restartsWidth) + " \u2502 " + padLeft(proc.memory || "N/A", memoryWidth));
  }
}
function formatStatus(status) {
  switch (status) {
    case "running":
      return "\uD83D\uDFE2 running";
    case "stopped":
      return "\uD83D\uDD34 stopped";
    case "errored":
      return "\uD83D\uDD34 errored";
    case "restarting":
      return "\uD83D\uDFE1 restarting";
    default:
      return status;
  }
}
function formatUptime(startTime) {
  const start = new Date(startTime);
  const now = new Date;
  const diffMs = now.getTime() - start.getTime();
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}
function formatMemory(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1000) {
    return `${(mb / 1024).toFixed(1)}GB`;
  }
  return `${mb.toFixed(1)}MB`;
}
function padRight(str, width) {
  return str.padEnd(width);
}
function padLeft(str, width) {
  return str.padStart(width);
}
async function handleScale(args) {
  if (args.length < 2) {
    console.error("Error: Process name/ID and instance count are required");
    console.error("Usage: bun-pm scale <name|id> <instances>");
    process.exit(1);
  }
  const processIdentifier = args[0];
  const instances = parseInt(args[1]);
  if (isNaN(instances) || instances < 1) {
    console.error("Error: Instance count must be a positive integer");
    process.exit(1);
  }
  await ensureDaemonRunning();
  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    const message = createIPCMessage("scale", { id: processIdentifier, instances });
    const response = await client.sendMessage(message);
    if (response.success) {
      console.log(`\u2713 Scaled ${processIdentifier} to ${instances} instance(s)`);
      if (response.data?.instances) {
        console.log(`  Active instances: ${response.data.instances.length}`);
        response.data.instances.forEach((instance, index) => {
          console.log(`    ${index + 1}. ${instance.id} (PID: ${instance.pid})`);
        });
      }
    } else {
      console.error(`\u2717 Failed to scale ${processIdentifier}: ${response.error}`);
      process.exit(1);
    }
  } finally {
    await client.disconnect();
  }
}
async function handleLogs(args) {
  if (args.length === 0) {
    console.error("Error: Process name or ID is required");
    console.error("Usage: bun-pm logs <name|id> [options]");
    process.exit(1);
  }
  const processIdentifier = args[0];
  const options = parseLogsOptions(args.slice(1));
  await ensureDaemonRunning();
  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    if (options.follow) {
      await handleStreamingLogs(client, processIdentifier, options);
    } else {
      const message = createIPCMessage("logs", {
        identifier: processIdentifier,
        lines: options.lines,
        filter: options.filter
      });
      const response = await client.sendMessage(message);
      if (response.success) {
        const { lines, processId, totalLines, filteredLines } = response.data;
        if (lines.length === 0) {
          console.log(`No logs found for process '${processId}'`);
          return;
        }
        for (const line of lines) {
          console.log(line);
        }
        if (options.filter && filteredLines !== totalLines) {
          console.log(`
--- Showing ${filteredLines} of ${totalLines} lines (filtered by: ${options.filter}) ---`);
        } else {
          console.log(`
--- Showing last ${lines.length} lines ---`);
        }
      } else {
        console.error(`\u2717 Failed to get logs: ${response.error}`);
        process.exit(1);
      }
    }
  } finally {
    await client.disconnect();
  }
}
async function handleStreamingLogs(client, processIdentifier, options) {
  console.log(`Following logs for process '${processIdentifier}' (Press Ctrl+C to exit)`);
  const initialMessage = createIPCMessage("logs", {
    identifier: processIdentifier,
    lines: options.lines || 50,
    filter: options.filter
  });
  const initialResponse = await client.sendMessage(initialMessage);
  if (!initialResponse.success) {
    console.error(`\u2717 Failed to get logs: ${initialResponse.error}`);
    process.exit(1);
  }
  const { lines, processId } = initialResponse.data;
  for (const line of lines) {
    console.log(line);
  }
  let lastLineCount = lines.length;
  const pollInterval = setInterval(async () => {
    try {
      const pollMessage = createIPCMessage("logs", {
        identifier: processIdentifier,
        lines: lastLineCount + 100,
        filter: options.filter
      });
      const pollResponse = await client.sendMessage(pollMessage);
      if (pollResponse.success) {
        const newLines = pollResponse.data.lines.slice(lastLineCount);
        if (newLines.length > 0) {
          for (const line of newLines) {
            console.log(line);
          }
          lastLineCount = pollResponse.data.lines.length;
        }
      }
    } catch (error) {
      console.error("Error polling logs:", error);
    }
  }, 1000);
  process.on("SIGINT", () => {
    clearInterval(pollInterval);
    console.log(`
Log streaming stopped`);
    process.exit(0);
  });
}
function parseLogsOptions(args) {
  const options = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    if (arg === "--lines" && i + 1 < args.length) {
      const lines = parseInt(args[++i]);
      if (isNaN(lines) || lines < 1) {
        throw new Error("Lines must be a positive integer");
      }
      options.lines = lines;
    } else if (arg === "--follow" || arg === "-f") {
      options.follow = true;
    } else if (arg === "--filter" && i + 1 < args.length) {
      options.filter = args[++i];
    }
  }
  return options;
}
function parseDeleteOptions(args) {
  const options = {};
  for (const arg of args) {
    if (arg === "--force" || arg === "-f") {
      options.force = true;
    }
  }
  return options;
}
async function promptConfirmation(message) {
  process.stdout.write(message + " ");
  return new Promise((resolve3) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (key) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      console.log();
      const response = key.toLowerCase().trim();
      resolve3(response === "y" || response === "yes");
    };
    process.stdin.on("data", onData);
  });
}
async function handleStartFromEcosystem(args) {
  const configPath = args[0];
  const appName = args[1];
  const fullConfigPath = resolve2(process.cwd(), configPath);
  if (!existsSync3(fullConfigPath)) {
    console.error(`Error: Configuration file not found: ${configPath}`);
    process.exit(1);
  }
  await ensureDaemonRunning();
  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    const message = createIPCMessage("startFromFile", {
      filePath: fullConfigPath,
      appName
    });
    const response = await client.sendMessage(message);
    if (response.success) {
      const { results, successCount, totalApps } = response.data;
      console.log(`\u2713 ${response.data.message}`);
      if (results && results.length > 0) {
        console.log(`
Results:`);
        for (const result of results) {
          if (result.success) {
            console.log(`  \u2713 ${result.name} (${result.id}) - ${result.instances} instance(s)`);
            if (result.pids) {
              result.pids.forEach((pid, index) => {
                console.log(`    Instance ${index + 1}: PID ${pid}`);
              });
            }
          } else {
            console.log(`  \u2717 ${result.name} (${result.id}) - ${result.error}`);
          }
        }
        if (successCount < totalApps) {
          console.log(`
Warning: ${totalApps - successCount} app(s) failed to start`);
        }
      }
    } else {
      console.error(`\u2717 Failed to start from ecosystem file: ${response.error}`);
      process.exit(1);
    }
  } finally {
    await client.disconnect();
  }
}
async function handleSave(args) {
  const filePath = args[0] || "ecosystem.json";
  const fullPath = resolve2(process.cwd(), filePath);
  await ensureDaemonRunning();
  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    const message = createIPCMessage("save", { filePath: fullPath });
    const response = await client.sendMessage(message);
    if (response.success) {
      console.log(`\u2713 ${response.data.message}`);
      if (response.data.processes) {
        console.log(`  Saved ${response.data.processCount} process configuration(s):`);
        response.data.processes.forEach((proc) => {
          console.log(`    - ${proc.name} (${proc.id})`);
        });
      }
    } else {
      console.error(`\u2717 Failed to save configuration: ${response.error}`);
      process.exit(1);
    }
  } finally {
    await client.disconnect();
  }
}
async function handleLoad(args) {
  if (args.length === 0) {
    console.error("Error: Configuration file path is required");
    console.error("Usage: bun-pm load <ecosystem.json>");
    process.exit(1);
  }
  const configPath = args[0];
  const fullPath = resolve2(process.cwd(), configPath);
  if (!existsSync3(fullPath)) {
    console.error(`Error: Configuration file not found: ${configPath}`);
    process.exit(1);
  }
  await ensureDaemonRunning();
  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    const message = createIPCMessage("load", { filePath: fullPath });
    const response = await client.sendMessage(message);
    if (response.success) {
      const { results, successCount, totalApps } = response.data;
      console.log(`\u2713 ${response.data.message}`);
      if (results && results.length > 0) {
        console.log(`
Results:`);
        for (const result of results) {
          if (result.success) {
            console.log(`  \u2713 ${result.name} (${result.id}) - ${result.instances} instance(s)`);
            if (result.pids) {
              result.pids.forEach((pid, index) => {
                console.log(`    Instance ${index + 1}: PID ${pid}`);
              });
            }
          } else {
            console.log(`  \u2717 ${result.name} (${result.id}) - ${result.error}`);
          }
        }
        if (successCount < totalApps) {
          console.log(`
Warning: ${totalApps - successCount} app(s) failed to start`);
        }
      }
    } else {
      console.error(`\u2717 Failed to load configuration: ${response.error}`);
      process.exit(1);
    }
  } finally {
    await client.disconnect();
  }
}
async function handleDelete(args) {
  if (args.length === 0) {
    console.error("Error: Process name or ID is required");
    console.error("Usage: bun-pm delete <name|id> [--force]");
    process.exit(1);
  }
  const processIdentifier = args[0];
  const options = parseDeleteOptions(args.slice(1));
  await ensureDaemonRunning();
  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    const infoMessage = createIPCMessage("show", { identifier: processIdentifier });
    const infoResponse = await client.sendMessage(infoMessage);
    if (!infoResponse.success) {
      console.error(`\u2717 Process '${processIdentifier}' not found`);
      process.exit(1);
    }
    const processInfo = infoResponse.data.process;
    const isRunning = processInfo.status === "running";
    if (!options.force) {
      console.log(`
Process Information:`);
      console.log(`  Name: ${processInfo.name || processInfo.id}`);
      console.log(`  ID: ${processInfo.id}`);
      console.log(`  Status: ${formatStatus(processInfo.status)}`);
      console.log(`  Script: ${processInfo.script || "N/A"}`);
      console.log(`  Instances: ${processInfo.instances || 1}`);
      if (isRunning) {
        console.log(`  PID: ${processInfo.pid || "N/A"}`);
        console.log(`
\u26A0\uFE0F  This process is currently running and will be stopped before deletion.`);
      }
      console.log(`
\u26A0\uFE0F  This action will permanently remove the process configuration.`);
      console.log(`    All process instances will be stopped and the configuration will be deleted.`);
      const confirmation = await promptConfirmation(`
Are you sure you want to delete process '${processInfo.name || processInfo.id}'? (y/N)`);
      if (!confirmation) {
        console.log("Delete operation cancelled.");
        return;
      }
    }
    const deleteMessage = createIPCMessage("delete", {
      identifier: processIdentifier,
      force: options.force
    });
    const response = await client.sendMessage(deleteMessage);
    if (response.success) {
      console.log(`\u2713 ${response.data.message}`);
      if (response.data.stoppedInstances && response.data.stoppedInstances.length > 0) {
        console.log(`  Stopped ${response.data.stoppedInstances.length} running instance(s)`);
      }
      if (response.data.removedLogs) {
        console.log(`  Cleaned up log files`);
      }
    } else {
      console.error(`\u2717 Failed to delete process: ${response.error}`);
      process.exit(1);
    }
  } finally {
    await client.disconnect();
  }
}
async function handleMonit(args) {
  await ensureDaemonRunning();
  console.log("Real-time process monitoring (Press Ctrl+C to exit)");
  console.log(`Refreshing every 5 seconds...
`);
  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    const displayMonitoring = async () => {
      try {
        const message = createIPCMessage("monit", {});
        const response = await client.sendMessage(message);
        if (response.success) {
          const { processes, systemInfo } = response.data;
          process.stdout.write("\x1B[2J\x1B[H");
          console.log("=== System Information ===");
          if (systemInfo) {
            const totalMemGB = (systemInfo.totalMemory / (1024 * 1024 * 1024)).toFixed(1);
            const freeMemGB = (systemInfo.freeMemory / (1024 * 1024 * 1024)).toFixed(1);
            const usedMemGB = ((systemInfo.totalMemory - systemInfo.freeMemory) / (1024 * 1024 * 1024)).toFixed(1);
            console.log(`CPU Cores: ${systemInfo.cpuCount}`);
            console.log(`Memory: ${usedMemGB}GB / ${totalMemGB}GB (${freeMemGB}GB free)`);
          }
          console.log(`
=== Process Monitoring ===`);
          if (!processes || processes.length === 0) {
            console.log("No processes running");
            return;
          }
          displayMonitoringTable(processes);
          console.log(`
Last updated: ${new Date().toLocaleTimeString()}`);
        } else {
          console.error(`Error getting monitoring data: ${response.error}`);
        }
      } catch (error) {
        console.error("Error during monitoring:", error);
      }
    };
    await displayMonitoring();
    const refreshInterval = setInterval(displayMonitoring, 5000);
    process.on("SIGINT", () => {
      clearInterval(refreshInterval);
      console.log(`
Monitoring stopped`);
      process.exit(0);
    });
    await new Promise(() => {});
  } finally {
    await client.disconnect();
  }
}
function displayMonitoringTable(processes) {
  const processInfos = processes.map((proc) => ({
    name: proc.name || proc.id,
    status: formatStatus(proc.status),
    pid: proc.pid || 0,
    cpu: proc.metrics?.cpu?.toFixed(1) || "0.0",
    memory: proc.metrics?.memory ? formatMemory(proc.metrics.memory) : "N/A",
    uptime: proc.metrics?.uptime ? formatUptimeSeconds(proc.metrics.uptime) : "N/A",
    restarts: proc.metrics?.restarts || 0
  }));
  if (processInfos.length === 0) {
    console.log("No processes running");
    return;
  }
  const nameWidth = Math.max(4, ...processInfos.map((p) => p.name.length));
  const statusWidth = Math.max(6, ...processInfos.map((p) => p.status.length));
  const pidWidth = Math.max(3, ...processInfos.map((p) => p.pid.toString().length));
  const cpuWidth = Math.max(4, ...processInfos.map((p) => p.cpu.length));
  const memoryWidth = Math.max(6, ...processInfos.map((p) => p.memory.length));
  const uptimeWidth = Math.max(6, ...processInfos.map((p) => p.uptime.length));
  const restartsWidth = Math.max(8, ...processInfos.map((p) => p.restarts.toString().length));
  console.log(padRight("NAME", nameWidth) + " \u2502 " + padRight("STATUS", statusWidth) + " \u2502 " + padLeft("PID", pidWidth) + " \u2502 " + padLeft("CPU%", cpuWidth) + " \u2502 " + padLeft("MEMORY", memoryWidth) + " \u2502 " + padRight("UPTIME", uptimeWidth) + " \u2502 " + padLeft("RESTARTS", restartsWidth));
  console.log("\u2500".repeat(nameWidth + statusWidth + pidWidth + cpuWidth + memoryWidth + uptimeWidth + restartsWidth + 18));
  for (const proc of processInfos) {
    console.log(padRight(proc.name, nameWidth) + " \u2502 " + padRight(proc.status, statusWidth) + " \u2502 " + padLeft(proc.pid.toString(), pidWidth) + " \u2502 " + padLeft(proc.cpu + "%", cpuWidth) + " \u2502 " + padLeft(proc.memory, memoryWidth) + " \u2502 " + padRight(proc.uptime, uptimeWidth) + " \u2502 " + padLeft(proc.restarts.toString(), restartsWidth));
  }
}
async function handleShow(args) {
  if (args.length === 0) {
    console.error("Error: Process name or ID is required");
    console.error("Usage: bun-pm show <name|id>");
    process.exit(1);
  }
  const processIdentifier = args[0];
  await ensureDaemonRunning();
  const client = new IPCClient(getDefaultSocketPath());
  try {
    await client.connect();
    const message = createIPCMessage("show", { identifier: processIdentifier });
    const response = await client.sendMessage(message);
    if (response.success) {
      const { process: proc, metrics, history } = response.data;
      console.log(`=== Process Information: ${proc.name || proc.id} ===
`);
      console.log("Basic Information:");
      console.log(`  ID: ${proc.id}`);
      console.log(`  Name: ${proc.name || "N/A"}`);
      console.log(`  Status: ${formatStatus(proc.status)}`);
      console.log(`  PID: ${proc.pid || "N/A"}`);
      console.log(`  Script: ${proc.script || "N/A"}`);
      console.log(`  Working Directory: ${proc.cwd || "N/A"}`);
      console.log(`  Instances: ${proc.instances || 1}`);
      console.log(`  Auto Restart: ${proc.autorestart ? "Yes" : "No"}`);
      console.log(`  Max Restarts: ${proc.maxRestarts || "N/A"}`);
      if (proc.memoryLimit) {
        console.log(`  Memory Limit: ${formatMemory(proc.memoryLimit)}`);
      }
      if (metrics) {
        console.log(`
Current Metrics:`);
        console.log(`  CPU Usage: ${metrics.cpu?.toFixed(1) || "0.0"}%`);
        console.log(`  Memory Usage: ${metrics.memory ? formatMemory(metrics.memory) : "N/A"}`);
        console.log(`  Uptime: ${metrics.uptime ? formatUptimeSeconds(metrics.uptime) : "N/A"}`);
        console.log(`  Restart Count: ${metrics.restarts || 0}`);
      }
      if (proc.env && Object.keys(proc.env).length > 0) {
        console.log(`
Environment Variables:`);
        for (const [key, value] of Object.entries(proc.env)) {
          console.log(`  ${key}=${value}`);
        }
      }
      if (history && history.length > 0) {
        console.log(`
Recent Metrics History (last 10 entries):`);
        console.log("  Time       CPU%   Memory    Uptime    Restarts");
        console.log("  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 \u2500\u2500\u2500\u2500\u2500\u2500 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
        const recentHistory = history.slice(-10);
        for (let i = 0;i < recentHistory.length; i++) {
          const entry = recentHistory[i];
          const timeAgo = `${(recentHistory.length - i) * 5}s ago`;
          console.log(`  ${padRight(timeAgo, 10)} ` + `${padLeft(entry.cpu?.toFixed(1) + "%" || "0.0%", 6)} ` + `${padLeft(entry.memory ? formatMemory(entry.memory) : "N/A", 9)} ` + `${padLeft(entry.uptime ? formatUptimeSeconds(entry.uptime) : "N/A", 9)} ` + `${padLeft((entry.restarts || 0).toString(), 8)}`);
        }
      }
    } else {
      console.error(`\u2717 Failed to get process information: ${response.error}`);
      process.exit(1);
    }
  } finally {
    await client.disconnect();
  }
}
function formatUptimeSeconds(seconds) {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}
function parseCommandOptions(args) {
  const options = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    if (arg === "--name" && i + 1 < args.length) {
      options.name = args[++i];
    } else if (arg === "--instances" && i + 1 < args.length) {
      const instances = parseInt(args[++i]);
      if (isNaN(instances) || instances < 1) {
        throw new Error("Instances must be a positive integer");
      }
      options.instances = instances;
    } else if (arg === "--autorestart") {
      options.autorestart = true;
    } else if (arg === "--no-autorestart") {
      options["no-autorestart"] = true;
    } else if (arg === "--env" && i + 1 < args.length) {
      if (!options.env)
        options.env = [];
      options.env.push(args[++i]);
    } else if (arg === "--cwd" && i + 1 < args.length) {
      options.cwd = args[++i];
    } else if (arg === "--memory-limit" && i + 1 < args.length) {
      const limit = parseInt(args[++i]);
      if (isNaN(limit) || limit <= 0) {
        throw new Error("Memory limit must be a positive integer (bytes)");
      }
      options["memory-limit"] = limit;
    }
  }
  return options;
}
function parseEnvVars(envArgs) {
  const env = {};
  for (const envArg of envArgs) {
    const [key, ...valueParts] = envArg.split("=");
    if (key && valueParts.length > 0) {
      env[key] = valueParts.join("=");
    }
  }
  return env;
}
async function handleDaemon(args) {
  if (args.length === 0) {
    console.error("Error: Daemon subcommand is required");
    console.error("Usage: bun-pm daemon <status|start|stop|restart>");
    process.exit(1);
  }
  const subcommand = args[0];
  const daemonManager = new DaemonManager(getDefaultSocketPath());
  switch (subcommand) {
    case "status":
      await handleDaemonStatus(daemonManager);
      break;
    case "start":
      await handleDaemonStart(daemonManager);
      break;
    case "stop":
      await handleDaemonStop(daemonManager);
      break;
    case "restart":
      await handleDaemonRestart(daemonManager);
      break;
    default:
      console.error(`Unknown daemon subcommand: ${subcommand}`);
      console.error("Usage: bun-pm daemon <status|start|stop|restart>");
      process.exit(1);
  }
}
async function handleDaemonStatus(daemonManager) {
  try {
    const status = await daemonManager.getDaemonStatus();
    console.log("=== Daemon Status ===");
    console.log(`Overall Status: ${status.healthStatus.toUpperCase()}`);
    console.log(`Socket Responding: ${status.socketResponding ? "\u2713" : "\u2717"}`);
    console.log(`PID File Exists: ${status.pidFileExists ? "\u2713" : "\u2717"}`);
    console.log(`Process Running: ${status.processRunning ? "\u2713" : "\u2717"}`);
    if (status.daemonInfo) {
      console.log(`
=== Daemon Information ===`);
      console.log(`PID: ${status.daemonInfo.pid}`);
      console.log(`Start Time: ${status.daemonInfo.startTime.toLocaleString()}`);
      console.log(`Socket Path: ${status.daemonInfo.socketPath}`);
      if (status.daemonInfo.version) {
        console.log(`Version: ${status.daemonInfo.version}`);
      }
      const uptime = Date.now() - status.daemonInfo.startTime.getTime();
      const uptimeSeconds = Math.floor(uptime / 1000);
      console.log(`Uptime: ${formatUptimeSeconds(uptimeSeconds)}`);
    }
    if (status.healthStatus === "unhealthy") {
      console.log(`
\u26A0\uFE0F  Daemon state is inconsistent. Consider running "bun-pm daemon restart"`);
    } else if (status.healthStatus === "unknown") {
      console.log(`
\uD83D\uDCA1 Daemon is not running. Use "bun-pm daemon start" to start it`);
    }
  } catch (error) {
    console.error(`Error getting daemon status: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
async function handleDaemonStart(daemonManager) {
  try {
    const status = await daemonManager.getDaemonStatus();
    if (status.healthStatus === "healthy") {
      console.log("Daemon is already running and healthy");
      return;
    }
    await daemonManager.startDaemon();
  } catch (error) {
    console.error(`Error starting daemon: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
async function handleDaemonStop(daemonManager) {
  try {
    await daemonManager.stopDaemon();
  } catch (error) {
    console.error(`Error stopping daemon: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
async function handleDaemonRestart(daemonManager) {
  try {
    await daemonManager.restartDaemon();
  } catch (error) {
    console.error(`Error restarting daemon: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
async function ensureDaemonRunning() {
  const daemonManager = new DaemonManager(getDefaultSocketPath());
  await daemonManager.ensureDaemonRunning();
}
async function handleErrors(args) {
  try {
    const limit = args.length > 0 ? parseInt(args[0]) : 50;
    if (isNaN(limit) || limit < 1) {
      console.error("Error: Limit must be a positive integer");
      process.exit(1);
    }
    const client = new IPCClient;
    await client.connect();
    const message = createIPCMessage("errors", { limit });
    const response = await client.sendMessage(message);
    if (response.success && response.data) {
      const { errors, totalCount } = response.data;
      if (errors.length === 0) {
        console.log("No errors found.");
        return;
      }
      console.log(`
\uD83D\uDCCB Error History (showing ${errors.length} of ${totalCount} errors)
`);
      for (const error of errors) {
        const timestamp = new Date(error.timestamp).toLocaleString();
        const severityIcon = getSeverityIcon(error.severity);
        const categoryBadge = `[${error.category.toUpperCase()}]`;
        console.log(`${severityIcon} ${timestamp} ${categoryBadge}`);
        console.log(`   ${error.message}`);
        if (error.context && Object.keys(error.context).length > 0) {
          const contextStr = Object.entries(error.context).filter(([key]) => !["originalError", "stack"].includes(key)).map(([key, value]) => `${key}: ${value}`).join(", ");
          if (contextStr) {
            console.log(`   Context: ${contextStr}`);
          }
        }
        console.log("");
      }
    } else {
      console.error(`Error getting error history: ${response.error}`);
      process.exit(1);
    }
  } catch (error) {
    console.error("Error:", createUserFriendlyError(error instanceof Error ? error : new Error(String(error))));
    process.exit(1);
  }
}
async function handleErrorStats(args) {
  try {
    const client = new IPCClient;
    await client.connect();
    const message = createIPCMessage("errorStats", {});
    const response = await client.sendMessage(message);
    if (response.success && response.data) {
      const { daemon, processManager, combined } = response.data;
      console.log(`
\uD83D\uDCCA Error Statistics
`);
      console.log("\uD83D\uDD04 Overall Statistics:");
      console.log(`   Total Errors: ${combined.total}`);
      console.log(`   Recent (1h): ${combined.recent}`);
      console.log("");
      console.log("\uD83D\uDEA8 By Severity:");
      const severities = ["critical", "error", "warning", "info"];
      for (const severity of severities) {
        const count = combined.bySeverity[severity] || 0;
        if (count > 0) {
          const icon = getSeverityIcon(severity);
          console.log(`   ${icon} ${severity}: ${count}`);
        }
      }
      console.log("");
      console.log("\uD83D\uDCC2 By Category:");
      const categories = Object.entries(combined.byCategory).filter(([, count]) => count > 0).sort(([, a], [, b]) => b - a);
      for (const [category, count] of categories) {
        console.log(`   ${category}: ${count}`);
      }
      if (categories.length === 0) {
        console.log("   No errors by category");
      }
      console.log("");
      console.log("\uD83D\uDD27 By Component:");
      console.log(`   Daemon: ${daemon.total} errors`);
      console.log(`   Process Manager: ${processManager.total} errors`);
    } else {
      console.error(`Error getting error statistics: ${response.error}`);
      process.exit(1);
    }
  } catch (error) {
    console.error("Error:", createUserFriendlyError(error instanceof Error ? error : new Error(String(error))));
    process.exit(1);
  }
}
function getSeverityIcon(severity) {
  switch (severity) {
    case "critical":
      return "\uD83D\uDD25";
    case "error":
      return "\u274C";
    case "warning":
      return "\u26A0\uFE0F";
    case "info":
      return "\u2139\uFE0F";
    default:
      return "\u2753";
  }
}
function showHelp() {
  console.log(`
bun-pm - Bun Process Manager

USAGE:
  bun-pm <command> [options]

COMMANDS:
  start <script|config>  Start a new process or ecosystem file
  stop <name|id>         Stop a running process
  restart <name|id>      Restart a process
  scale <name|id> <n>    Scale process to n instances
  delete <name|id>       Delete a process configuration
  list, ls              List all processes
  logs <name|id>        Show process logs
  monit                 Real-time process monitoring
  show <name|id>        Show detailed process information
  save [file]           Save current processes to ecosystem file
  load <file>           Load processes from ecosystem file
  errors [limit]        Show recent error history
  error-stats           Show error statistics
  daemon <subcommand>   Manage daemon (status|start|stop|restart)

START OPTIONS:
  --name <name>           Set process name
  --instances <n>         Number of instances to start
  --autorestart          Enable automatic restart (default)
  --no-autorestart       Disable automatic restart
  --env <KEY=VALUE>      Set environment variable (can be used multiple times)
  --cwd <path>           Set working directory
  --memory-limit <bytes> Set memory limit in bytes

LOGS OPTIONS:
  --lines <n>            Number of lines to show (default: 100)
  --follow, -f           Follow log output in real-time
  --filter <pattern>     Filter logs by pattern (regex)

DELETE OPTIONS:
  --force, -f            Skip confirmation prompt

GLOBAL OPTIONS:
  --help, -h         Show this help message
  --version, -v      Show version information

EXAMPLES:
  # Start individual processes
  bun-pm start app.ts
  bun-pm start server.js --name web-server --instances 4
  bun-pm start api.ts --env PORT=3000 --env NODE_ENV=production
  
  # Ecosystem file operations
  bun-pm start ecosystem.json           # Start all apps in ecosystem file
  bun-pm start ecosystem.json my-app    # Start specific app from ecosystem file
  bun-pm save ecosystem.json            # Save current processes to file
  bun-pm load ecosystem.json            # Load and start processes from file
  
  # Process management
  bun-pm stop web-server
  bun-pm restart api
  bun-pm scale web-server 8
  bun-pm delete old-process
  bun-pm delete web-server --force
  bun-pm list
  
  # Logging
  bun-pm logs web-server
  bun-pm logs api --lines 50 --follow
  bun-pm logs web-server --filter "error"
`);
}
function showVersion() {
  const packagePath = new URL("../../package.json", import.meta.url).pathname;
  try {
    const packageJson = JSON.parse(Bun.file(packagePath).text());
    console.log(`bun-pm v${packageJson.version}`);
  } catch {
    console.log("bun-pm v1.0.0");
  }
}
if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
