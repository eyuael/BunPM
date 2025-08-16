import { Subprocess } from "bun";
import { existsSync } from "fs";
import { resolve } from "path";

/**
 * Configuration for a managed process
 */
export interface ProcessConfig {
  id: string;
  name: string;
  script: string;
  cwd: string;
  env: Record<string, string>;
  instances: number;
  autorestart: boolean;
  maxRestarts: number;
  memoryLimit?: number;
}

/**
 * Validation result structure
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

/**
 * Validates a ProcessConfig object
 */
export function validateProcessConfig(config: any): ValidationResult {
  const errors: string[] = [];

  // Check required fields
  if (!config.id || typeof config.id !== 'string' || config.id.trim() === '') {
    errors.push('id is required and must be a non-empty string');
  }

  if (!config.name || typeof config.name !== 'string' || config.name.trim() === '') {
    errors.push('name is required and must be a non-empty string');
  }

  if (!config.script || typeof config.script !== 'string' || config.script.trim() === '') {
    errors.push('script is required and must be a non-empty string');
  } else {
    // Check if script file exists
    const scriptPath = resolve(config.cwd || process.cwd(), config.script);
    if (!existsSync(scriptPath)) {
      errors.push(`script file does not exist: ${scriptPath}`);
    }
  }

  if (!config.cwd || typeof config.cwd !== 'string' || config.cwd.trim() === '') {
    errors.push('cwd is required and must be a non-empty string');
  } else {
    // Check if working directory exists
    if (!existsSync(config.cwd)) {
      errors.push(`working directory does not exist: ${config.cwd}`);
    }
  }

  // Validate env object
  if (config.env !== undefined) {
    if (typeof config.env !== 'object' || config.env === null || Array.isArray(config.env)) {
      errors.push('env must be an object');
    } else {
      for (const [key, value] of Object.entries(config.env)) {
        if (typeof key !== 'string' || typeof value !== 'string') {
          errors.push('env values must be string key-value pairs');
          break;
        }
      }
    }
  }

  // Validate instances
  if (config.instances !== undefined) {
    if (!Number.isInteger(config.instances) || config.instances < 1) {
      errors.push('instances must be a positive integer');
    }
  }

  // Validate autorestart
  if (config.autorestart !== undefined && typeof config.autorestart !== 'boolean') {
    errors.push('autorestart must be a boolean');
  }

  // Validate maxRestarts
  if (config.maxRestarts !== undefined) {
    if (!Number.isInteger(config.maxRestarts) || config.maxRestarts < 0) {
      errors.push('maxRestarts must be a non-negative integer');
    }
  }

  // Validate memoryLimit
  if (config.memoryLimit !== undefined) {
    if (!Number.isInteger(config.memoryLimit) || config.memoryLimit <= 0) {
      errors.push('memoryLimit must be a positive integer (bytes)');
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Creates a ProcessConfig with default values
 */
export function createProcessConfig(partial: Partial<ProcessConfig> & Pick<ProcessConfig, 'id' | 'name' | 'script'>): ProcessConfig {
  return {
    cwd: process.cwd(),
    env: {},
    instances: 1,
    autorestart: true,
    maxRestarts: 10,
    ...partial
  };
}

/**
 * Runtime instance of a managed process
 */
export interface ProcessInstance {
  id: string;
  pid: number;
  status: 'running' | 'stopped' | 'errored' | 'restarting';
  startTime: Date;
  restartCount: number;
  subprocess: Subprocess;
}

/**
 * Process status type
 */
export type ProcessStatus = 'running' | 'stopped' | 'errored' | 'restarting';

/**
 * Validates a ProcessInstance object
 */
export function validateProcessInstance(instance: any): ValidationResult {
  const errors: string[] = [];

  if (!instance.id || typeof instance.id !== 'string') {
    errors.push('id is required and must be a string');
  }

  if (!Number.isInteger(instance.pid) || instance.pid <= 0) {
    errors.push('pid must be a positive integer');
  }

  const validStatuses: ProcessStatus[] = ['running', 'stopped', 'errored', 'restarting'];
  if (!validStatuses.includes(instance.status)) {
    errors.push(`status must be one of: ${validStatuses.join(', ')}`);
  }

  if (!(instance.startTime instanceof Date) || isNaN(instance.startTime.getTime())) {
    errors.push('startTime must be a valid Date object');
  }

  if (!Number.isInteger(instance.restartCount) || instance.restartCount < 0) {
    errors.push('restartCount must be a non-negative integer');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Creates a ProcessInstance with default values
 */
export function createProcessInstance(
  id: string,
  pid: number,
  subprocess: Subprocess,
  status: ProcessStatus = 'running'
): ProcessInstance {
  return {
    id,
    pid,
    status,
    startTime: new Date(),
    restartCount: 0,
    subprocess
  };
}

/**
 * Updates the status of a ProcessInstance
 */
export function updateProcessStatus(instance: ProcessInstance, newStatus: ProcessStatus): ProcessInstance {
  return {
    ...instance,
    status: newStatus
  };
}

/**
 * Increments the restart count of a ProcessInstance
 */
export function incrementRestartCount(instance: ProcessInstance): ProcessInstance {
  return {
    ...instance,
    restartCount: instance.restartCount + 1
  };
}

/**
 * IPC message structure for client-daemon communication
 */
export interface IPCMessage {
  id: string;
  command: string;
  payload: any;
}

/**
 * IPC response structure from daemon to client
 */
export interface IPCResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Validates an IPCMessage object
 */
export function validateIPCMessage(message: any): ValidationResult {
  const errors: string[] = [];

  if (!message.id || typeof message.id !== 'string') {
    errors.push('id is required and must be a string');
  }

  if (!message.command || typeof message.command !== 'string') {
    errors.push('command is required and must be a string');
  }

  // payload can be any type, so no validation needed

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Validates an IPCResponse object
 */
export function validateIPCResponse(response: any): ValidationResult {
  const errors: string[] = [];

  if (!response.id || typeof response.id !== 'string') {
    errors.push('id is required and must be a string');
  }

  if (typeof response.success !== 'boolean') {
    errors.push('success is required and must be a boolean');
  }

  if (response.error !== undefined && typeof response.error !== 'string') {
    errors.push('error must be a string if provided');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Serializes an IPCMessage to JSON string
 */
export function serializeIPCMessage(message: IPCMessage): string {
  try {
    return JSON.stringify(message);
  } catch (error) {
    throw new Error(`Failed to serialize IPC message: ${error}`);
  }
}

/**
 * Deserializes a JSON string to IPCMessage
 */
export function deserializeIPCMessage(data: string): IPCMessage {
  try {
    const parsed = JSON.parse(data);
    const validation = validateIPCMessage(parsed);
    if (!validation.isValid) {
      throw new Error(`Invalid IPC message: ${validation.errors.join(', ')}`);
    }
    return parsed as IPCMessage;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in IPC message: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Serializes an IPCResponse to JSON string
 */
export function serializeIPCResponse(response: IPCResponse): string {
  try {
    return JSON.stringify(response);
  } catch (error) {
    throw new Error(`Failed to serialize IPC response: ${error}`);
  }
}

/**
 * Deserializes a JSON string to IPCResponse
 */
export function deserializeIPCResponse(data: string): IPCResponse {
  try {
    const parsed = JSON.parse(data);
    const validation = validateIPCResponse(parsed);
    if (!validation.isValid) {
      throw new Error(`Invalid IPC response: ${validation.errors.join(', ')}`);
    }
    return parsed as IPCResponse;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in IPC response: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Creates an IPCMessage with a generated ID
 */
export function createIPCMessage(command: string, payload: any = {}): IPCMessage {
  return {
    id: crypto.randomUUID(),
    command,
    payload
  };
}

/**
 * Creates a successful IPCResponse
 */
export function createSuccessResponse(id: string, data?: any): IPCResponse {
  return {
    id,
    success: true,
    data
  };
}

/**
 * Creates an error IPCResponse
 */
export function createErrorResponse(id: string, error: string): IPCResponse {
  return {
    id,
    success: false,
    error
  };
}

/**
 * CLI command structure
 */
export interface CLICommand {
  command: string;
  args: string[];
  options: Record<string, any>;
}

/**
 * CLI response structure
 */
export interface CLIResponse {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Process metrics for monitoring
 */
export interface ProcessMetrics {
  cpu: number;
  memory: number;
  uptime: number;
  restarts: number;
}

/**
 * Log entry structure
 */
export interface LogEntry {
  timestamp: Date;
  processId: string;
  stream: 'stdout' | 'stderr';
  message: string;
}

/**
 * Ecosystem configuration file structure
 */
export interface EcosystemConfig {
  apps: ProcessConfig[];
  version: string;
  created: Date;
}

/**
 * Daemon state structure
 */
export interface DaemonState {
  pid: number;
  startTime: Date;
  processes: Record<string, ProcessInstance>;
  socketPath: string;
}

/**
 * Error handling types
 */
export interface ErrorContext {
  processId?: string;
  command?: string;
  filePath?: string;
  operation?: string;
  [key: string]: any;
}

/**
 * Error recovery attempt result
 */
export interface ErrorRecoveryResult {
  success: boolean;
  message: string;
  retryable: boolean;
  recoveryStrategy?: string;
  context?: ErrorContext;
}