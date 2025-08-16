/**
 * Comprehensive error handling system for the Bun Process Manager
 * Provides structured error types, recovery strategies, and detailed logging
 */

/**
 * Base error class for all process manager errors
 */
export abstract class ProcessManagerError extends Error {
  public readonly code: string;
  public readonly category: ErrorCategory;
  public readonly severity: ErrorSeverity;
  public readonly timestamp: Date;
  public readonly context?: Record<string, any>;
  public readonly recoverable: boolean;

  constructor(
    message: string,
    code: string,
    category: ErrorCategory,
    severity: ErrorSeverity = 'error',
    recoverable: boolean = false,
    context?: Record<string, any>
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.category = category;
    this.severity = severity;
    this.timestamp = new Date();
    this.context = context;
    this.recoverable = recoverable;

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Get a user-friendly error message
   */
  getUserMessage(): string {
    return this.message;
  }

  /**
   * Get detailed error information for logging
   */
  getDetailedInfo(): ErrorDetails {
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

/**
 * Error categories for classification
 */
export type ErrorCategory = 
  | 'process'      // Process lifecycle errors
  | 'config'       // Configuration errors
  | 'ipc'          // IPC communication errors
  | 'filesystem'   // File system errors
  | 'validation'   // Data validation errors
  | 'resource'     // Resource management errors
  | 'network'      // Network-related errors
  | 'system';      // System-level errors

/**
 * Error severity levels
 */
export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

/**
 * Detailed error information structure
 */
export interface ErrorDetails {
  name: string;
  message: string;
  code: string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  timestamp: Date;
  context?: Record<string, any>;
  recoverable: boolean;
  stack?: string;
}

/**
 * Process-related errors
 */
export class ProcessError extends ProcessManagerError {
  constructor(
    message: string,
    code: string,
    severity: ErrorSeverity = 'error',
    recoverable: boolean = true,
    context?: Record<string, any>
  ) {
    super(message, code, 'process', severity, recoverable, context);
  }
}

/**
 * Process startup failure
 */
export class ProcessStartupError extends ProcessError {
  constructor(processId: string, reason: string, context?: Record<string, any>) {
    super(
      `Failed to start process '${processId}': ${reason}`,
      'PROCESS_STARTUP_FAILED',
      'error',
      true,
      { processId, reason, ...context }
    );
  }

  getUserMessage(): string {
    const processId = this.context?.processId || 'unknown';
    const reason = this.context?.reason || 'unknown error';
    return `Unable to start process '${processId}'. ${reason}`;
  }
}

/**
 * Process crash error
 */
export class ProcessCrashError extends ProcessError {
  constructor(
    processId: string, 
    exitCode: number, 
    signal?: string, 
    context?: Record<string, any>
  ) {
    const signalInfo = signal ? ` (signal: ${signal})` : '';
    super(
      `Process '${processId}' crashed with exit code ${exitCode}${signalInfo}`,
      'PROCESS_CRASHED',
      'warning',
      true,
      { processId, exitCode, signal, ...context }
    );
  }

  getUserMessage(): string {
    const processId = this.context?.processId || 'unknown';
    const exitCode = this.context?.exitCode || 'unknown';
    return `Process '${processId}' stopped unexpectedly (exit code: ${exitCode})`;
  }
}

/**
 * Process restart limit exceeded
 */
export class ProcessRestartLimitError extends ProcessError {
  constructor(processId: string, maxRestarts: number, context?: Record<string, any>) {
    super(
      `Process '${processId}' exceeded maximum restart attempts (${maxRestarts})`,
      'PROCESS_RESTART_LIMIT_EXCEEDED',
      'error',
      false,
      { processId, maxRestarts, ...context }
    );
  }

  getUserMessage(): string {
    const processId = this.context?.processId || 'unknown';
    const maxRestarts = this.context?.maxRestarts || 'unknown';
    return `Process '${processId}' has failed too many times (${maxRestarts} attempts). Please check the logs and fix any issues before restarting.`;
  }
}

/**
 * Memory limit exceeded error
 */
export class ProcessMemoryLimitError extends ProcessError {
  constructor(
    processId: string, 
    currentMemory: number, 
    memoryLimit: number, 
    context?: Record<string, any>
  ) {
    super(
      `Process '${processId}' exceeded memory limit (${currentMemory} > ${memoryLimit} bytes)`,
      'PROCESS_MEMORY_LIMIT_EXCEEDED',
      'warning',
      true,
      { processId, currentMemory, memoryLimit, ...context }
    );
  }

  getUserMessage(): string {
    const processId = this.context?.processId || 'unknown';
    const currentMemory = this.context?.currentMemory || 0;
    const memoryLimit = this.context?.memoryLimit || 0;
    const currentMB = Math.round(currentMemory / 1024 / 1024);
    const limitMB = Math.round(memoryLimit / 1024 / 1024);
    return `Process '${processId}' is using too much memory (${currentMB}MB > ${limitMB}MB limit). Restarting to free memory.`;
  }
}

/**
 * Configuration-related errors
 */
export class ConfigurationError extends ProcessManagerError {
  constructor(
    message: string,
    code: string,
    severity: ErrorSeverity = 'error',
    recoverable: boolean = false,
    context?: Record<string, any>
  ) {
    super(message, code, 'config', severity, recoverable, context);
  }
}

/**
 * Invalid configuration error
 */
export class InvalidConfigurationError extends ConfigurationError {
  constructor(errors: string[], context?: Record<string, any>) {
    super(
      `Invalid configuration: ${errors.join(', ')}`,
      'INVALID_CONFIGURATION',
      'error',
      false,
      { validationErrors: errors, ...context }
    );
  }

  getUserMessage(): string {
    const errors = this.context?.validationErrors || [];
    if (errors.length === 1) {
      return `Configuration error: ${errors[0]}`;
    }
    return `Configuration has ${errors.length} errors:\n${errors.map((e: string) => `  • ${e}`).join('\n')}`;
  }
}

/**
 * Configuration file not found error
 */
export class ConfigurationFileNotFoundError extends ConfigurationError {
  constructor(filePath: string, context?: Record<string, any>) {
    super(
      `Configuration file not found: ${filePath}`,
      'CONFIG_FILE_NOT_FOUND',
      'error',
      false,
      { filePath, ...context }
    );
  }

  getUserMessage(): string {
    const filePath = this.context?.filePath || 'unknown';
    return `Configuration file '${filePath}' does not exist. Please check the file path and try again.`;
  }
}

/**
 * IPC communication errors
 */
export class IPCError extends ProcessManagerError {
  constructor(
    message: string,
    code: string,
    severity: ErrorSeverity = 'error',
    recoverable: boolean = true,
    context?: Record<string, any>
  ) {
    super(message, code, 'ipc', severity, recoverable, context);
  }
}

/**
 * IPC connection failed error
 */
export class IPCConnectionError extends IPCError {
  constructor(socketPath: string, reason?: string, context?: Record<string, any>) {
    const reasonText = reason ? `: ${reason}` : '';
    super(
      `Failed to connect to daemon at ${socketPath}${reasonText}`,
      'IPC_CONNECTION_FAILED',
      'error',
      true,
      { socketPath, reason, ...context }
    );
  }

  getUserMessage(): string {
    return 'Unable to connect to the process daemon. The daemon may not be running or there may be a permission issue.';
  }
}

/**
 * IPC timeout error
 */
export class IPCTimeoutError extends IPCError {
  constructor(command: string, timeoutMs: number, context?: Record<string, any>) {
    super(
      `IPC command '${command}' timed out after ${timeoutMs}ms`,
      'IPC_TIMEOUT',
      'warning',
      true,
      { command, timeoutMs, ...context }
    );
  }

  getUserMessage(): string {
    const command = this.context?.command || 'unknown';
    return `Command '${command}' took too long to complete. The daemon may be overloaded.`;
  }
}

/**
 * File system errors
 */
export class FileSystemError extends ProcessManagerError {
  constructor(
    message: string,
    code: string,
    severity: ErrorSeverity = 'error',
    recoverable: boolean = false,
    context?: Record<string, any>
  ) {
    super(message, code, 'filesystem', severity, recoverable, context);
  }
}

/**
 * File not found error
 */
export class FileNotFoundError extends FileSystemError {
  constructor(filePath: string, context?: Record<string, any>) {
    super(
      `File not found: ${filePath}`,
      'FILE_NOT_FOUND',
      'error',
      false,
      { filePath, ...context }
    );
  }

  getUserMessage(): string {
    const filePath = this.context?.filePath || 'unknown';
    return `File '${filePath}' does not exist. Please check the file path and try again.`;
  }
}

/**
 * Permission denied error
 */
export class PermissionDeniedError extends FileSystemError {
  constructor(filePath: string, operation: string, context?: Record<string, any>) {
    super(
      `Permission denied: cannot ${operation} ${filePath}`,
      'PERMISSION_DENIED',
      'error',
      false,
      { filePath, operation, ...context }
    );
  }

  getUserMessage(): string {
    const filePath = this.context?.filePath || 'unknown';
    const operation = this.context?.operation || 'access';
    return `Permission denied: cannot ${operation} '${filePath}'. Please check file permissions.`;
  }
}

/**
 * Resource management errors
 */
export class ResourceError extends ProcessManagerError {
  constructor(
    message: string,
    code: string,
    severity: ErrorSeverity = 'warning',
    recoverable: boolean = true,
    context?: Record<string, any>
  ) {
    super(message, code, 'resource', severity, recoverable, context);
  }
}

/**
 * System resource exhaustion error
 */
export class ResourceExhaustionError extends ResourceError {
  constructor(resource: string, context?: Record<string, any>) {
    super(
      `System resource exhausted: ${resource}`,
      'RESOURCE_EXHAUSTED',
      'critical',
      false,
      { resource, ...context }
    );
  }

  getUserMessage(): string {
    const resource = this.context?.resource || 'unknown';
    return `System is running low on ${resource}. Some operations may fail until resources are freed.`;
  }
}

/**
 * Error recovery strategies
 */
export interface RecoveryStrategy {
  name: string;
  description: string;
  canRecover(error: ProcessManagerError): boolean;
  recover(error: ProcessManagerError, context?: any): Promise<RecoveryResult>;
}

/**
 * Recovery result
 */
export interface RecoveryResult {
  success: boolean;
  message: string;
  retryable: boolean;
  context?: Record<string, any>;
}

/**
 * Process restart recovery strategy
 */
export class ProcessRestartRecovery implements RecoveryStrategy {
  name = 'process-restart';
  description = 'Restart failed processes with exponential backoff';

  canRecover(error: ProcessManagerError): boolean {
    return error instanceof ProcessCrashError || 
           error instanceof ProcessMemoryLimitError;
  }

  async recover(error: ProcessManagerError, processManager?: any): Promise<RecoveryResult> {
    if (!processManager) {
      return {
        success: false,
        message: 'Process manager not available for recovery',
        retryable: false
      };
    }

    const processId = error.context?.processId;
    if (!processId) {
      return {
        success: false,
        message: 'Process ID not available for recovery',
        retryable: false
      };
    }

    try {
      // Check if process can still be restarted
      const restartStats = processManager.getRestartStats(processId);
      if (!restartStats?.canRestart) {
        return {
          success: false,
          message: `Process '${processId}' cannot be restarted (max attempts reached)`,
          retryable: false
        };
      }

      // Process manager will handle the restart with backoff
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

/**
 * IPC reconnection recovery strategy
 */
export class IPCReconnectionRecovery implements RecoveryStrategy {
  name = 'ipc-reconnection';
  description = 'Reconnect to IPC server with exponential backoff';

  canRecover(error: ProcessManagerError): boolean {
    return error instanceof IPCConnectionError || error instanceof IPCTimeoutError;
  }

  async recover(error: ProcessManagerError, ipcClient?: any): Promise<RecoveryResult> {
    if (!ipcClient) {
      return {
        success: false,
        message: 'IPC client not available for recovery',
        retryable: false
      };
    }

    try {
      // Attempt to reconnect
      await ipcClient.connect();
      return {
        success: true,
        message: 'Successfully reconnected to daemon',
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

/**
 * Comprehensive error handler
 */
export class ErrorHandler {
  private recoveryStrategies: RecoveryStrategy[] = [];
  private errorLog: ErrorDetails[] = [];
  private maxLogSize: number = 1000;

  constructor() {
    // Register default recovery strategies
    this.registerRecoveryStrategy(new ProcessRestartRecovery());
    this.registerRecoveryStrategy(new IPCReconnectionRecovery());
  }

  /**
   * Register a recovery strategy
   */
  registerRecoveryStrategy(strategy: RecoveryStrategy): void {
    this.recoveryStrategies.push(strategy);
  }

  /**
   * Handle an error with logging and recovery
   */
  async handleError(
    error: Error | ProcessManagerError, 
    context?: any
  ): Promise<{ handled: boolean; recovered: boolean; message: string }> {
    // Convert regular errors to ProcessManagerError
    const processError = error instanceof ProcessManagerError 
      ? error 
      : this.convertToProcessManagerError(error);

    // Log the error
    this.logError(processError);

    // Try to recover if the error is recoverable
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

  /**
   * Convert a regular Error to ProcessManagerError
   */
  private convertToProcessManagerError(error: Error): ProcessManagerError {
    // Try to infer error type from message patterns
    const message = error.message.toLowerCase();

    if (message.includes('enoent') || message.includes('not found')) {
      return new FileNotFoundError(error.message, { originalError: error.message });
    }

    if (message.includes('eacces') || message.includes('permission')) {
      return new PermissionDeniedError(error.message, 'access', { originalError: error.message });
    }

    if (message.includes('connection') || message.includes('socket')) {
      return new IPCConnectionError('unknown', error.message, { originalError: error.message });
    }

    // Default to generic process error
    return new ProcessError(
      error.message,
      'UNKNOWN_ERROR',
      'error',
      false,
      { originalError: error.message, stack: error.stack }
    );
  }

  /**
   * Log an error
   */
  private logError(error: ProcessManagerError): void {
    const errorDetails = error.getDetailedInfo();
    
    // Add to error log
    this.errorLog.push(errorDetails);
    
    // Trim log if it gets too large
    if (this.errorLog.length > this.maxLogSize) {
      this.errorLog = this.errorLog.slice(-this.maxLogSize);
    }

    // Console logging based on severity
    const timestamp = errorDetails.timestamp.toISOString();
    const prefix = `[${timestamp}] [${errorDetails.severity.toUpperCase()}] [${errorDetails.category}]`;
    
    switch (errorDetails.severity) {
      case 'critical':
        console.error(`${prefix} CRITICAL: ${errorDetails.message}`);
        if (errorDetails.context) {
          console.error('Context:', errorDetails.context);
        }
        break;
      case 'error':
        console.error(`${prefix} ${errorDetails.message}`);
        break;
      case 'warning':
        console.warn(`${prefix} ${errorDetails.message}`);
        break;
      case 'info':
        console.log(`${prefix} ${errorDetails.message}`);
        break;
    }
  }

  /**
   * Attempt to recover from an error
   */
  private async attemptRecovery(
    error: ProcessManagerError, 
    context?: any
  ): Promise<RecoveryResult> {
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
      message: 'No recovery strategy available for this error',
      retryable: false
    };
  }

  /**
   * Get recent error history
   */
  getErrorHistory(limit?: number): ErrorDetails[] {
    const errors = limit ? this.errorLog.slice(-limit) : this.errorLog;
    return [...errors]; // Return copy to prevent mutation
  }

  /**
   * Get error statistics
   */
  getErrorStats(): {
    total: number;
    byCategory: Record<ErrorCategory, number>;
    bySeverity: Record<ErrorSeverity, number>;
    recent: number; // Last hour
  } {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const stats = {
      total: this.errorLog.length,
      byCategory: {} as Record<ErrorCategory, number>,
      bySeverity: {} as Record<ErrorSeverity, number>,
      recent: 0
    };

    // Initialize counters
    const categories: ErrorCategory[] = ['process', 'config', 'ipc', 'filesystem', 'validation', 'resource', 'network', 'system'];
    const severities: ErrorSeverity[] = ['info', 'warning', 'error', 'critical'];
    
    categories.forEach(cat => stats.byCategory[cat] = 0);
    severities.forEach(sev => stats.bySeverity[sev] = 0);

    // Count errors
    for (const error of this.errorLog) {
      stats.byCategory[error.category]++;
      stats.bySeverity[error.severity]++;
      
      if (error.timestamp >= oneHourAgo) {
        stats.recent++;
      }
    }

    return stats;
  }

  /**
   * Clear error history
   */
  clearErrorHistory(): void {
    this.errorLog = [];
  }
}

/**
 * Global error handler instance
 */
export const globalErrorHandler = new ErrorHandler();

/**
 * Utility function to create user-friendly error messages
 */
export function createUserFriendlyError(error: Error | ProcessManagerError): string {
  if (error instanceof ProcessManagerError) {
    return error.getUserMessage();
  }

  // Handle common Node.js/system errors
  const message = error.message;
  
  if (message.includes('ENOENT')) {
    return 'File or directory not found. Please check the path and try again.';
  }
  
  if (message.includes('EACCES')) {
    return 'Permission denied. Please check file permissions or run with appropriate privileges.';
  }
  
  if (message.includes('EADDRINUSE')) {
    return 'Address already in use. Another process may be using the same port or socket.';
  }
  
  if (message.includes('ECONNREFUSED')) {
    return 'Connection refused. The target service may not be running.';
  }

  // Default fallback
  return message || 'An unknown error occurred';
}