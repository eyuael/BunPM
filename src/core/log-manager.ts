import { Subprocess } from "bun";
import { mkdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { LogEntry } from "../types/index.js";

/**
 * Log manager interface
 */
export interface ILogManager {
  captureOutput(processId: string, subprocess: Subprocess): void;
  getLogs(processId: string, lines?: number): Promise<string[]>;
  streamLogs(processId: string): AsyncIterableIterator<string>;
  rotateLogs(processId: string): Promise<void>;
  stopCapture(processId: string): void;
}

/**
 * Log manager implementation using Bun streams
 */
export class LogManager implements ILogManager {
  private readonly logDir: string;
  private readonly maxLogSize: number = 10 * 1024 * 1024; // 10MB
  private readonly captureStreams = new Map<string, { stdout: ReadableStream; stderr: ReadableStream }>();
  private readonly activeCaptures = new Map<string, AbortController>();

  constructor(logDir: string = join(process.env.HOME || "/tmp", ".bun-pm", "logs")) {
    this.logDir = logDir;
  }

  /**
   * Capture output from a subprocess and store to log files
   */
  captureOutput(processId: string, subprocess: Subprocess): void {
    if (this.activeCaptures.has(processId)) {
      this.stopCapture(processId);
    }

    const controller = new AbortController();
    this.activeCaptures.set(processId, controller);

    // Ensure log directory exists
    this.ensureLogDirectory(processId);

    // Capture stdout
    if (subprocess.stdout) {
      this.captureStream(processId, subprocess.stdout, 'stdout', controller.signal);
    }

    // Capture stderr  
    if (subprocess.stderr) {
      this.captureStream(processId, subprocess.stderr, 'stderr', controller.signal);
    }
  }

  /**
   * Get the last n lines from process logs
   */
  async getLogs(processId: string, lines: number = 100): Promise<string[]> {
    const logFiles = await this.getLogFiles(processId);
    const allLines: string[] = [];

    // Read from all log files (current and rotated)
    for (const logFile of logFiles.reverse()) { // Start with newest
      try {
        const file = Bun.file(logFile);
        if (await file.exists()) {
          const content = await file.text();
          const fileLines = content.split('\n').filter(line => line.trim() !== '');
          allLines.unshift(...fileLines);
        }
      } catch (error) {
        console.error(`Error reading log file ${logFile}:`, error);
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
   * Stop capturing output for a process
   */
  stopCapture(processId: string): void {
    const controller = this.activeCaptures.get(processId);
    if (controller) {
      controller.abort();
      this.activeCaptures.delete(processId);
    }
    this.captureStreams.delete(processId);
  }

  /**
   * Capture a single stream (stdout or stderr)
   */
  private async captureStream(
    processId: string, 
    stream: ReadableStream, 
    streamType: 'stdout' | 'stderr',
    signal: AbortSignal
  ): Promise<void> {
    const logPath = this.getLogPath(processId, streamType);
    
    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        
        if (done) break;
        
        const text = decoder.decode(value, { stream: true });
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] ${text}`;
        
        // Write to log file
        await this.appendToLogFile(logPath, logLine);
        
        // Check if rotation is needed
        await this.checkAndRotateIfNeeded(processId, streamType);
      }
    } catch (error) {
      if (!signal.aborted) {
        console.error(`Error capturing ${streamType} for process ${processId}:`, error);
      }
    }
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
}