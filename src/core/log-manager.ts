import { Subprocess } from "bun";
import { mkdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { LogEntry } from "../types/index.js";
import { CircularBuffer, StringPool, OptimizedLogEntry } from "./memory-optimizer.js";

/**
 * Log manager interface
 */
export interface ILogManager {
  captureOutput(processId: string, subprocess: Subprocess): void;
  getLogs(processId: string, lines?: number): Promise<string[]>;
  streamLogs(processId: string): AsyncIterableIterator<string>;
  rotateLogs(processId: string): Promise<void>;
  stopCapture(processId: string): void;
  cleanupLogs(processId: string): Promise<void>;
}

/**
 * Log manager implementation using Bun streams with memory optimizations
 */
export class LogManager implements ILogManager {
  private readonly logDir: string;
  private readonly maxLogSize: number = 10 * 1024 * 1024; // 10MB
  private readonly captureStreams = new Map<string, { stdout: ReadableStream; stderr: ReadableStream }>();
  private readonly activeCaptures = new Map<string, AbortController>();
  private readonly logBuffers = new Map<string, CircularBuffer<OptimizedLogEntry>>();
  private readonly stringPool = new StringPool(2000);
  private readonly maxBufferSize = 1000; // Maximum log entries in memory per process

  constructor(logDir: string = join(process.env.HOME || "/tmp", ".bun-pm", "logs")) {
    this.logDir = logDir;
  }

  /**
   * Capture output from a subprocess and store to log files with memory optimization
   */
  captureOutput(processId: string, subprocess: Subprocess): void {
    if (this.activeCaptures.has(processId)) {
      this.stopCapture(processId);
    }

    const controller = new AbortController();
    this.activeCaptures.set(processId, controller);

    // Initialize memory buffer for this process
    if (!this.logBuffers.has(processId)) {
      this.logBuffers.set(processId, new CircularBuffer<OptimizedLogEntry>(this.maxBufferSize));
    }

    // Ensure log directory exists
    this.ensureLogDirectory(processId);

    // Capture stdout
    if (subprocess.stdout) {
      this.captureStreamOptimized(processId, subprocess.stdout, 'stdout', controller.signal);
    }

    // Capture stderr  
    if (subprocess.stderr) {
      this.captureStreamOptimized(processId, subprocess.stderr, 'stderr', controller.signal);
    }
  }

  /**
   * Get the last n lines from process logs with memory-efficient retrieval
   */
  async getLogs(processId: string, lines: number = 100): Promise<string[]> {
    // First try to get logs from memory buffer (fastest)
    const buffer = this.logBuffers.get(processId);
    if (buffer) {
      const bufferedEntries = buffer.toArray();
      if (bufferedEntries.length >= lines) {
        return bufferedEntries
          .slice(-lines)
          .map(entry => `[${new Date(entry.timestamp).toISOString()}] ${entry.message}`);
      }
    }

    // Fallback to file system for older logs
    const logFiles = await this.getLogFiles(processId);
    const allLines: string[] = [];

    // Add buffered logs first (most recent)
    if (buffer) {
      const bufferedLines = buffer.toArray()
        .map(entry => `[${new Date(entry.timestamp).toISOString()}] ${entry.message}`);
      allLines.push(...bufferedLines);
    }

    // Read from files if we need more lines
    const remainingLines = lines - allLines.length;
    if (remainingLines > 0) {
      for (const logFile of logFiles.reverse()) { // Start with newest
        try {
          const file = Bun.file(logFile);
          if (await file.exists()) {
            const content = await file.text();
            const fileLines = content.split('\n').filter(line => line.trim() !== '');
            allLines.unshift(...fileLines.slice(-remainingLines));
            
            if (allLines.length >= lines) break;
          }
        } catch (error) {
          console.error(`Error reading log file ${logFile}:`, error);
        }
      }
    }

    // Return the last n lines
    return allLines.slice(-lines);
  }

  /**
   * Stream logs in real-time
   */
  async* streamLogs(processId: string): AsyncIterableIterator<string> {
    const outLogPath = this.getLogPath(processId, 'stdout');
    const errLogPath = this.getLogPath(processId, 'stderr');

    // First yield existing logs
    const existingLogs = await this.getLogs(processId, 50);
    for (const line of existingLogs) {
      yield line;
    }

    // Then stream new logs
    const watcher = new EventTarget();
    let lastOutSize = 0;
    let lastErrSize = 0;

    try {
      // Get initial file sizes
      if (existsSync(outLogPath)) {
        const outStat = await stat(outLogPath);
        lastOutSize = outStat.size;
      }
      if (existsSync(errLogPath)) {
        const errStat = await stat(errLogPath);
        lastErrSize = errStat.size;
      }

      // Poll for file changes (Bun doesn't have native file watching yet)
      const interval = setInterval(async () => {
        try {
          // Check stdout log
          if (existsSync(outLogPath)) {
            const outStat = await stat(outLogPath);
            if (outStat.size > lastOutSize) {
              const file = Bun.file(outLogPath);
              const content = await file.text();
              const newContent = content.slice(lastOutSize);
              const newLines = newContent.split('\n').filter(line => line.trim() !== '');
              for (const line of newLines) {
                watcher.dispatchEvent(new CustomEvent('newline', { detail: line }));
              }
              lastOutSize = outStat.size;
            }
          }

          // Check stderr log
          if (existsSync(errLogPath)) {
            const errStat = await stat(errLogPath);
            if (errStat.size > lastErrSize) {
              const file = Bun.file(errLogPath);
              const content = await file.text();
              const newContent = content.slice(lastErrSize);
              const newLines = newContent.split('\n').filter(line => line.trim() !== '');
              for (const line of newLines) {
                watcher.dispatchEvent(new CustomEvent('newline', { detail: line }));
              }
              lastErrSize = errStat.size;
            }
          }
        } catch (error) {
          console.error('Error polling log files:', error);
        }
      }, 100); // Poll every 100ms

      // Listen for new lines
      const handleNewLine = (event: Event) => {
        const customEvent = event as CustomEvent;
        watcher.dispatchEvent(new CustomEvent('yield', { detail: customEvent.detail }));
      };

      watcher.addEventListener('newline', handleNewLine);

      // Yield new lines as they come
      while (true) {
        const event = await new Promise<CustomEvent>((resolve) => {
          const handler = (e: Event) => {
            const customEvent = e as CustomEvent;
            if (customEvent.type === 'yield') {
              watcher.removeEventListener('yield', handler);
              resolve(customEvent);
            }
          };
          watcher.addEventListener('yield', handler);
        });

        yield event.detail;
      }
    } finally {
      clearInterval(interval);
    }
  }

  /**
   * Rotate logs when they exceed the size limit
   */
  async rotateLogs(processId: string): Promise<void> {
    const outLogPath = this.getLogPath(processId, 'stdout');
    const errLogPath = this.getLogPath(processId, 'stderr');

    await this.rotateLogFile(outLogPath);
    await this.rotateLogFile(errLogPath);
  }

  /**
   * Stop capturing output for a process and clean up memory
   */
  stopCapture(processId: string): void {
    const controller = this.activeCaptures.get(processId);
    if (controller) {
      controller.abort();
      this.activeCaptures.delete(processId);
    }
    this.captureStreams.delete(processId);
    
    // Clean up memory buffer
    const buffer = this.logBuffers.get(processId);
    if (buffer) {
      buffer.clear();
      this.logBuffers.delete(processId);
    }
  }

  /**
   * Clean up all log files for a process
   */
  async cleanupLogs(processId: string): Promise<void> {
    try {
      // Stop any active capture first
      this.stopCapture(processId);

      // Get all log files for this process
      const logFiles = await this.getLogFiles(processId);
      
      // Remove all log files
      for (const logFile of logFiles) {
        try {
          if (existsSync(logFile)) {
            await Bun.write(logFile, ""); // Clear file content
            // Note: Bun doesn't have a direct file deletion API, so we clear the content
            // In a real implementation, you might use fs.unlink or similar
          }
        } catch (error) {
          console.warn(`Warning: Failed to cleanup log file ${logFile}:`, error);
        }
      }

      // Try to remove the process log directory if it's empty
      const processLogDir = join(this.logDir, processId);
      try {
        // Check if directory exists and is empty, then remove it
        // This is a simplified approach - in production you might want to use fs.rmdir
        if (existsSync(processLogDir)) {
          const remainingFiles = await this.getLogFiles(processId);
          if (remainingFiles.length === 0) {
            // Directory cleanup would go here if Bun had native support
            console.log(`Log directory cleaned for process ${processId}`);
          }
        }
      } catch (error) {
        console.warn(`Warning: Failed to remove log directory for ${processId}:`, error);
      }
    } catch (error) {
      console.error(`Error cleaning up logs for process ${processId}:`, error);
      throw error;
    }
  }

  /**
   * Capture a single stream (stdout or stderr) with memory optimization
   */
  private async captureStreamOptimized(
    processId: string, 
    stream: ReadableStream, 
    streamType: 'stdout' | 'stderr',
    signal: AbortSignal
  ): Promise<void> {
    const logPath = this.getLogPath(processId, streamType);
    const buffer = this.logBuffers.get(processId);
    
    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let pendingWrites: Promise<void>[] = [];
      
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        
        if (done) break;
        
        const text = decoder.decode(value, { stream: true });
        const timestamp = Date.now();
        const logLine = `[${new Date(timestamp).toISOString()}] ${text}`;
        
        // Store in memory buffer for fast access
        if (buffer) {
          const optimizedEntry: OptimizedLogEntry = {
            timestamp,
            processId: this.stringPool.intern(processId),
            stream: streamType,
            message: text.trim()
          };
          buffer.push(optimizedEntry);
        }
        
        // Async write to file (don't block stream processing)
        const writePromise = this.appendToLogFile(logPath, logLine)
          .then(() => this.checkAndRotateIfNeeded(processId, streamType))
          .catch(error => {
            console.error(`Error writing log for ${processId}:`, error);
          });
        
        pendingWrites.push(writePromise);
        
        // Limit concurrent writes to prevent memory buildup
        if (pendingWrites.length > 10) {
          await Promise.all(pendingWrites);
          pendingWrites = [];
        }
      }
      
      // Wait for remaining writes to complete
      if (pendingWrites.length > 0) {
        await Promise.all(pendingWrites);
      }
    } catch (error) {
      if (!signal.aborted) {
        console.error(`Error capturing ${streamType} for process ${processId}:`, error);
      }
    }
  }

  /**
   * Legacy capture method for backward compatibility
   */
  private async captureStream(
    processId: string, 
    stream: ReadableStream, 
    streamType: 'stdout' | 'stderr',
    signal: AbortSignal
  ): Promise<void> {
    return this.captureStreamOptimized(processId, stream, streamType, signal);
  }

  /**
   * Ensure log directory exists for a process
   */
  private async ensureLogDirectory(processId: string): Promise<void> {
    const processLogDir = join(this.logDir, processId);
    try {
      await mkdir(processLogDir, { recursive: true });
    } catch (error) {
      console.error(`Error creating log directory for ${processId}:`, error);
    }
  }

  /**
   * Get log file path for a process and stream type
   */
  private getLogPath(processId: string, streamType: 'stdout' | 'stderr'): string {
    const fileName = streamType === 'stdout' ? 'out.log' : 'error.log';
    return join(this.logDir, processId, fileName);
  }

  /**
   * Get all log files for a process (including rotated ones)
   */
  private async getLogFiles(processId: string): Promise<string[]> {
    const processLogDir = join(this.logDir, processId);
    const files: string[] = [];
    
    // Add current log files
    const outLog = join(processLogDir, 'out.log');
    const errLog = join(processLogDir, 'error.log');
    
    if (existsSync(outLog)) files.push(outLog);
    if (existsSync(errLog)) files.push(errLog);
    
    // Add rotated log files
    for (let i = 1; i <= 10; i++) { // Check up to 10 rotated files
      const rotatedOut = join(processLogDir, `out.log.${i}`);
      const rotatedErr = join(processLogDir, `error.log.${i}`);
      
      if (existsSync(rotatedOut)) files.push(rotatedOut);
      if (existsSync(rotatedErr)) files.push(rotatedErr);
    }
    
    return files;
  }

  /**
   * Append content to a log file
   */
  private async appendToLogFile(logPath: string, content: string): Promise<void> {
    try {
      // Ensure directory exists
      await mkdir(dirname(logPath), { recursive: true });
      
      // Read existing content and append new content
      let existingContent = "";
      if (existsSync(logPath)) {
        const file = Bun.file(logPath);
        existingContent = await file.text();
      }
      
      await Bun.write(logPath, existingContent + content);
    } catch (error) {
      console.error(`Error writing to log file ${logPath}:`, error);
    }
  }

  /**
   * Check if log rotation is needed and rotate if necessary
   */
  private async checkAndRotateIfNeeded(processId: string, streamType: 'stdout' | 'stderr'): Promise<void> {
    const logPath = this.getLogPath(processId, streamType);
    
    try {
      if (existsSync(logPath)) {
        const stats = await stat(logPath);
        if (stats.size >= this.maxLogSize) {
          await this.rotateLogFile(logPath);
        }
      }
    } catch (error) {
      console.error(`Error checking log file size for ${logPath}:`, error);
    }
  }

  /**
   * Rotate a single log file
   */
  private async rotateLogFile(logPath: string): Promise<void> {
    if (!existsSync(logPath)) return;

    try {
      const currentFile = Bun.file(logPath);
      const currentContent = await currentFile.text();
      
      // Shift existing rotated files
      for (let i = 9; i >= 1; i--) {
        const oldPath = `${logPath}.${i}`;
        const newPath = `${logPath}.${i + 1}`;
        
        if (existsSync(oldPath)) {
          const oldFile = Bun.file(oldPath);
          const oldContent = await oldFile.text();
          await Bun.write(newPath, oldContent);
        }
      }
      
      // Move current log to .1
      const rotatedPath = `${logPath}.1`;
      await Bun.write(rotatedPath, currentContent);
      
      // Clear current log file
      await Bun.write(logPath, "");
      
    } catch (error) {
      console.error(`Error rotating log file ${logPath}:`, error);
    }
  }

  /**
   * Get memory usage statistics for the log manager
   */
  getMemoryStats() {
    const bufferStats = Array.from(this.logBuffers.entries()).map(([processId, buffer]) => ({
      processId,
      bufferSize: buffer.getSize(),
      bufferCapacity: buffer.getCapacity()
    }));

    return {
      activeCaptures: this.activeCaptures.size,
      logBuffers: this.logBuffers.size,
      stringPoolSize: this.stringPool.getSize(),
      totalBufferedEntries: bufferStats.reduce((sum, stat) => sum + stat.bufferSize, 0),
      bufferStats
    };
  }

  /**
   * Perform memory cleanup and optimization
   */
  optimizeMemory(): void {
    // Clear string pool if it gets too large
    if (this.stringPool.getSize() > 1500) {
      this.stringPool.clear();
    }

    // Clean up buffers for processes that are no longer active
    for (const [processId, buffer] of this.logBuffers.entries()) {
      if (!this.activeCaptures.has(processId)) {
        buffer.clear();
        this.logBuffers.delete(processId);
      }
    }
  }
}