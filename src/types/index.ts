import { Subprocess } from "bun";

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