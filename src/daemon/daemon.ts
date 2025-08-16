import { resolve, dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import { IPCServer, getDefaultSocketPath } from "../ipc/socket.js";
import { ProcessManager } from "../core/process-manager.js";
import { LogManager } from "../core/log-manager.js";
import {
    IPCMessage,
    IPCResponse,
    createSuccessResponse,
    createErrorResponse,
    ProcessConfig,
    DaemonState,
    validateProcessConfig
} from "../types/index.js";

/**
 * Main daemon class that manages processes and handles IPC communication
 */
export class ProcessDaemon {
    private ipcServer: IPCServer;
    private processManager: ProcessManager;
    private logManager: LogManager;
    private socketPath: string;
    private stateFilePath: string;
    private isRunning: boolean = false;
    private processConfigs: Map<string, ProcessConfig> = new Map();

    constructor(socketPath?: string) {
        this.socketPath = socketPath || getDefaultSocketPath();
        this.stateFilePath = this.getStateFilePath();
        this.ipcServer = new IPCServer(this.socketPath);
        this.logManager = new LogManager();
        this.processManager = new ProcessManager(this.logManager);

        this.setupCommandHandlers();
    }

    /**
     * Start the daemon
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            throw new Error('Daemon is already running');
        }

        try {
            // Ensure daemon directory exists
            const daemonDir = dirname(this.socketPath);
            if (!existsSync(daemonDir)) {
                mkdirSync(daemonDir, { recursive: true });
            }

            // Load previous state if it exists
            await this.loadState();

            // Start IPC server
            await this.ipcServer.start();

            // Set up graceful shutdown handlers
            this.setupShutdownHandlers();

            this.isRunning = true;

            // Save current daemon state
            await this.saveState();

            console.log(`Process daemon started on ${this.socketPath}`);
        } catch (error) {
            throw new Error(`Failed to start daemon: ${error}`);
        }
    }

    /**
     * Stop the daemon gracefully
     */
    async stop(): Promise<void> {
        if (!this.isRunning) {
            return;
        }

        console.log('Stopping daemon gracefully...');

        try {
            // Save current state before shutdown
            await this.saveState();

            // Stop all managed processes
            await this.processManager.cleanup();

            // Stop IPC server
            await this.ipcServer.stop();

            // Clean up state file
            await this.cleanupStateFile();

            this.isRunning = false;

            console.log('Daemon stopped successfully');
        } catch (error) {
            console.error(`Error during daemon shutdown: ${error}`);
            throw error;
        }
    }

    /**
     * Check if daemon is running
     */
    isActive(): boolean {
        return this.isRunning;
    }

    /**
     * Get daemon state file path
     */
    private getStateFilePath(): string {
        const daemonDir = dirname(this.socketPath);
        return resolve(daemonDir, 'daemon.json');
    }

    /**
     * Set up command handlers for IPC messages
     */
    private setupCommandHandlers(): void {
        // Process management commands
        this.ipcServer.registerHandler('start', this.handleStartCommand.bind(this));
        this.ipcServer.registerHandler('stop', this.handleStopCommand.bind(this));
        this.ipcServer.registerHandler('restart', this.handleRestartCommand.bind(this));
        this.ipcServer.registerHandler('list', this.handleListCommand.bind(this));
        this.ipcServer.registerHandler('scale', this.handleScaleCommand.bind(this));
        this.ipcServer.registerHandler('delete', this.handleDeleteCommand.bind(this));

        // Log management commands
        this.ipcServer.registerHandler('logs', this.handleLogsCommand.bind(this));

        // Daemon management commands
        this.ipcServer.registerHandler('status', this.handleStatusCommand.bind(this));
        this.ipcServer.registerHandler('shutdown', this.handleShutdownCommand.bind(this));

        // Configuration commands
        this.ipcServer.registerHandler('save', this.handleSaveCommand.bind(this));
        this.ipcServer.registerHandler('load', this.handleLoadCommand.bind(this));
    }

    /**
     * Handle start process command
     */
    private async handleStartCommand(message: IPCMessage): Promise<IPCResponse> {
        try {
            const { config } = message.payload;

            // Validate process configuration
            const validation = validateProcessConfig(config);
            if (!validation.isValid) {
                return createErrorResponse(message.id, `Invalid configuration: ${validation.errors.join(', ')}`);
            }

            // Check if process already exists
            if (this.processConfigs.has(config.id)) {
                return createErrorResponse(message.id, `Process with id '${config.id}' already exists`);
            }

            // Start the process
            const instances = await this.processManager.start(config);

            // Store configuration
            this.processConfigs.set(config.id, config);

            // Save state
            await this.saveState();

            return createSuccessResponse(message.id, {
                message: `Started ${instances.length} instance(s) of process '${config.name}'`,
                instances: instances.map(instance => ({
                    id: instance.id,
                    pid: instance.pid,
                    status: instance.status,
                    startTime: instance.startTime
                }))
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return createErrorResponse(message.id, errorMessage);
        }
    }

    /**
     * Handle stop process command
     */
    private async handleStopCommand(message: IPCMessage): Promise<IPCResponse> {
        try {
            const { id } = message.payload;

            if (!id) {
                return createErrorResponse(message.id, 'Process id is required');
            }

            await this.processManager.stop(id);
            await this.saveState();

            return createSuccessResponse(message.id, {
                message: `Process '${id}' stopped successfully`
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return createErrorResponse(message.id, errorMessage);
        }
    }

    /**
     * Handle restart process command
     */
    private async handleRestartCommand(message: IPCMessage): Promise<IPCResponse> {
        try {
            const { id } = message.payload;

            if (!id) {
                return createErrorResponse(message.id, 'Process id is required');
            }

            const instance = await this.processManager.restart(id);
            await this.saveState();

            return createSuccessResponse(message.id, {
                message: `Process '${id}' restarted successfully`,
                instance: {
                    id: instance.id,
                    pid: instance.pid,
                    status: instance.status,
                    startTime: instance.startTime
                }
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return createErrorResponse(message.id, errorMessage);
        }
    }

    /**
     * Handle list processes command
     */
    private async handleListCommand(message: IPCMessage): Promise<IPCResponse> {
        try {
            const instances = this.processManager.list();

            return createSuccessResponse(message.id, {
                processes: instances.map(instance => ({
                    id: instance.id,
                    pid: instance.pid,
                    status: instance.status,
                    startTime: instance.startTime,
                    restartCount: instance.restartCount
                }))
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return createErrorResponse(message.id, errorMessage);
        }
    }

    /**
     * Handle scale process command
     */
    private async handleScaleCommand(message: IPCMessage): Promise<IPCResponse> {
        try {
            const { id, instances } = message.payload;

            if (!id) {
                return createErrorResponse(message.id, 'Process id is required');
            }

            if (!Number.isInteger(instances) || instances < 1) {
                return createErrorResponse(message.id, 'Instances must be a positive integer');
            }

            const scaledInstances = await this.processManager.scale(id, instances);
            await this.saveState();

            return createSuccessResponse(message.id, {
                message: `Process '${id}' scaled to ${instances} instance(s)`,
                instances: scaledInstances.map(instance => ({
                    id: instance.id,
                    pid: instance.pid,
                    status: instance.status,
                    startTime: instance.startTime
                }))
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return createErrorResponse(message.id, errorMessage);
        }
    }

    /**
     * Handle delete process command
     */
    private async handleDeleteCommand(message: IPCMessage): Promise<IPCResponse> {
        try {
            const { id } = message.payload;

            if (!id) {
                return createErrorResponse(message.id, 'Process id is required');
            }

            // Stop the process first
            try {
                await this.processManager.stop(id);
            } catch (error) {
                // Process might not be running, continue with deletion
            }

            // Remove configuration
            this.processConfigs.delete(id);
            await this.saveState();

            return createSuccessResponse(message.id, {
                message: `Process '${id}' deleted successfully`
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return createErrorResponse(message.id, errorMessage);
        }
    }

    /**
     * Handle logs command
     */
    private async handleLogsCommand(message: IPCMessage): Promise<IPCResponse> {
        try {
            const { identifier, lines, follow, filter } = message.payload;

            if (!identifier) {
                return createErrorResponse(message.id, 'Process name or ID is required');
            }

            // Find the process by name or ID (check both running and configured processes)
            const processes = this.processManager.list();
            let process = processes.find(p => p.id === identifier || p.id.includes(identifier));
            let processId = identifier;

            // If not found in running processes, check if we have logs for this identifier
            if (!process) {
                // Try to find a process config that matches
                const configs = Array.from(this.processConfigs.values());
                const config = configs.find(c => c.id === identifier || c.name === identifier);
                if (config) {
                    processId = config.id;
                } else {
                    // Check if logs exist for this identifier directly
                    try {
                        const testLogs = await this.logManager.getLogs(identifier, 1);
                        if (testLogs.length === 0) {
                            return createErrorResponse(message.id, `Process '${identifier}' not found`);
                        }
                        processId = identifier;
                    } catch (error) {
                        return createErrorResponse(message.id, `Process '${identifier}' not found`);
                    }
                }
            } else {
                processId = process.id;
            }

            if (follow) {
                // For streaming logs, we'll return a special response indicating streaming mode
                return createSuccessResponse(message.id, {
                    streaming: true,
                    processId: processId,
                    message: 'Log streaming started'
                });
            } else {
                // Get historical logs
                const logLines = await this.logManager.getLogs(processId, lines || 100);
                
                // Apply filter if provided
                let filteredLines = logLines;
                if (filter) {
                    const filterRegex = new RegExp(filter, 'i');
                    filteredLines = logLines.filter(line => filterRegex.test(line));
                }

                return createSuccessResponse(message.id, {
                    processId: processId,
                    lines: filteredLines,
                    totalLines: logLines.length,
                    filteredLines: filteredLines.length
                });
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return createErrorResponse(message.id, errorMessage);
        }
    }

    /**
     * Handle daemon status command
     */
    private async handleStatusCommand(message: IPCMessage): Promise<IPCResponse> {
        try {
            const processes = this.processManager.list();

            return createSuccessResponse(message.id, {
                daemon: {
                    pid: process.pid,
                    uptime: process.uptime(),
                    socketPath: this.socketPath,
                    processCount: processes.length,
                    connections: this.ipcServer.getConnectionCount()
                },
                processes: processes.length
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return createErrorResponse(message.id, errorMessage);
        }
    }

    /**
     * Handle daemon shutdown command
     */
    private async handleShutdownCommand(message: IPCMessage): Promise<IPCResponse> {
        try {
            // Send response before shutting down
            const response = createSuccessResponse(message.id, {
                message: 'Daemon shutting down...'
            });

            // Schedule shutdown after response is sent
            setTimeout(() => {
                this.stop().catch(error => {
                    console.error('Error during shutdown:', error);
                    process.exit(1);
                });
            }, 100);

            return response;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return createErrorResponse(message.id, errorMessage);
        }
    }

    /**
     * Handle save configuration command
     */
    private async handleSaveCommand(message: IPCMessage): Promise<IPCResponse> {
        try {
            const { filePath } = message.payload;

            if (!filePath) {
                return createErrorResponse(message.id, 'File path is required');
            }

            const ecosystemConfig = {
                apps: Array.from(this.processConfigs.values()),
                version: '1.0.0',
                created: new Date()
            };

            await Bun.write(filePath, JSON.stringify(ecosystemConfig, null, 2));

            return createSuccessResponse(message.id, {
                message: `Configuration saved to ${filePath}`,
                processCount: this.processConfigs.size
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return createErrorResponse(message.id, errorMessage);
        }
    }

    /**
     * Handle load configuration command
     */
    private async handleLoadCommand(message: IPCMessage): Promise<IPCResponse> {
        try {
            const { filePath } = message.payload;

            if (!filePath) {
                return createErrorResponse(message.id, 'File path is required');
            }

            if (!existsSync(filePath)) {
                return createErrorResponse(message.id, `Configuration file not found: ${filePath}`);
            }

            const configFile = Bun.file(filePath);
            const configData = await configFile.json();

            if (!configData.apps || !Array.isArray(configData.apps)) {
                return createErrorResponse(message.id, 'Invalid configuration file format');
            }

            const results = [];
            for (const config of configData.apps) {
                try {
                    const validation = validateProcessConfig(config);
                    if (!validation.isValid) {
                        results.push({
                            id: config.id || 'unknown',
                            success: false,
                            error: validation.errors.join(', ')
                        });
                        continue;
                    }

                    const instances = await this.processManager.start(config);
                    this.processConfigs.set(config.id, config);

                    results.push({
                        id: config.id,
                        success: true,
                        instances: instances.length
                    });
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    results.push({
                        id: config.id || 'unknown',
                        success: false,
                        error: errorMessage
                    });
                }
            }

            await this.saveState();

            return createSuccessResponse(message.id, {
                message: `Loaded configuration from ${filePath}`,
                results
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return createErrorResponse(message.id, errorMessage);
        }
    }

    /**
     * Save daemon state to disk
     */
    private async saveState(): Promise<void> {
        try {
            const processes = this.processManager.list();
            const processMap: Record<string, any> = {};

            for (const instance of processes) {
                processMap[instance.id] = {
                    id: instance.id,
                    pid: instance.pid,
                    status: instance.status,
                    startTime: instance.startTime.toISOString(),
                    restartCount: instance.restartCount
                };
            }

            const state: DaemonState = {
                pid: process.pid,
                startTime: new Date(),
                processes: processMap,
                socketPath: this.socketPath
            };

            await Bun.write(this.stateFilePath, JSON.stringify(state, null, 2));
        } catch (error) {
            console.error('Failed to save daemon state:', error);
        }
    }

    /**
     * Load daemon state from disk
     */
    private async loadState(): Promise<void> {
        try {
            if (!existsSync(this.stateFilePath)) {
                return; // No previous state to load
            }

            const stateFile = Bun.file(this.stateFilePath);
            const state = await stateFile.json() as DaemonState;

            // Note: In a real implementation, we would need to restore process instances
            // For now, we just log that we found previous state
            console.log(`Found previous daemon state with ${Object.keys(state.processes).length} processes`);

            // Clean up stale state file since we can't restore processes
            await this.cleanupStateFile();
        } catch (error) {
            console.error('Failed to load daemon state:', error);
            // Clean up corrupted state file
            await this.cleanupStateFile();
        }
    }

    /**
     * Clean up state file
     */
    private async cleanupStateFile(): Promise<void> {
        try {
            if (existsSync(this.stateFilePath)) {
                await Bun.write(this.stateFilePath, ''); // Clear file content
            }
        } catch (error) {
            console.error('Failed to cleanup state file:', error);
        }
    }

    /**
     * Set up graceful shutdown handlers
     */
    private setupShutdownHandlers(): void {
        const shutdown = async (signal: string) => {
            console.log(`\nReceived ${signal}, shutting down gracefully...`);
            try {
                await this.stop();
                process.exit(0);
            } catch (error) {
                console.error('Error during shutdown:', error);
                process.exit(1);
            }
        };

        // Handle various shutdown signals
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGHUP', () => shutdown('SIGHUP'));

        // Handle uncaught exceptions
        process.on('uncaughtException', async (error) => {
            console.error('Uncaught exception:', error);
            try {
                await this.stop();
            } catch (shutdownError) {
                console.error('Error during emergency shutdown:', shutdownError);
            }
            process.exit(1);
        });

        // Handle unhandled promise rejections
        process.on('unhandledRejection', async (reason, promise) => {
            console.error('Unhandled rejection at:', promise, 'reason:', reason);
            try {
                await this.stop();
            } catch (shutdownError) {
                console.error('Error during emergency shutdown:', shutdownError);
            }
            process.exit(1);
        });
    }
}