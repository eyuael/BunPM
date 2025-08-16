import { resolve, dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import { IPCServer, getDefaultSocketPath } from "../ipc/socket.js";
import { ProcessManager } from "../core/process-manager.js";
import { LogManager } from "../core/log-manager.js";
import { ConfigManager } from "../core/config-manager.js";
import { MonitorManager } from "../core/monitor-manager.js";
import { DaemonManager } from "../core/daemon-manager.js";
import {
    IPCMessage,
    IPCResponse,
    createSuccessResponse,
    createErrorResponse,
    ProcessConfig,
    DaemonState,
    validateProcessConfig
} from "../types/index.js";
import {
    ErrorHandler,
    InvalidConfigurationError,
    ConfigurationFileNotFoundError,
    createUserFriendlyError
} from "../core/error-handler.js";
import { 
    MemoryTracker, 
    GCOptimizer, 
    OptimizedProcessConfigStore 
} from "../core/memory-optimizer.js";

/**
 * Main daemon class that manages processes and handles IPC communication
 */
export class ProcessDaemon {
    private ipcServer: IPCServer;
    private processManager: ProcessManager;
    private logManager: LogManager;
    private configManager: ConfigManager;
    private monitorManager: MonitorManager;
    private daemonManager: DaemonManager;
    private socketPath: string;
    private stateFilePath: string;
    private isRunning: boolean = false;
    private processConfigs: OptimizedProcessConfigStore = new OptimizedProcessConfigStore();
    private errorHandler: ErrorHandler;
    private memoryTracker: MemoryTracker;
    private gcOptimizer: GCOptimizer;

    constructor(socketPath?: string) {
        this.socketPath = socketPath || getDefaultSocketPath();
        this.stateFilePath = this.getStateFilePath();
        this.ipcServer = new IPCServer(this.socketPath);
        this.logManager = new LogManager();
        this.monitorManager = new MonitorManager();
        this.processManager = new ProcessManager(this.logManager, this.monitorManager);
        this.configManager = new ConfigManager();
        this.daemonManager = new DaemonManager(this.socketPath);
        this.errorHandler = new ErrorHandler();
        this.memoryTracker = new MemoryTracker(100);
        this.gcOptimizer = new GCOptimizer(this.memoryTracker);

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

            // Write PID file
            await this.daemonManager.writePidFile(process.pid);

            // Load previous state if it exists
            await this.loadState();

            // Start IPC server
            await this.ipcServer.start();

            // Set up graceful shutdown handlers
            this.setupShutdownHandlers();

            // Start memory optimization
            this.gcOptimizer.startPeriodicGC();
            this.memoryTracker.recordMeasurement();
            
            // Start periodic memory optimization
            setInterval(() => {
                this.optimizeMemory();
            }, 60000); // Every minute

            this.isRunning = true;

            // Save current daemon state
            await this.saveState();

            console.log(`Process daemon started on ${this.socketPath} (PID: ${process.pid})`);
        } catch (error) {
            // Clean up PID file if startup failed
            await this.daemonManager.removePidFile();
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

            // Clean up monitoring
            this.monitorManager.cleanup();

            // Stop memory optimization
            this.gcOptimizer.stopPeriodicGC();

            // Stop IPC server
            await this.ipcServer.stop();

            // Clean up PID file
            await this.daemonManager.removePidFile();

            // Clean up state file
            await this.cleanupStateFile();

            this.isRunning = false;

            console.log('Daemon stopped successfully');
        } catch (error) {
            console.error(`Error during daemon shutdown: ${error}`);
            // Still try to clean up PID file even if other cleanup failed
            await this.daemonManager.removePidFile();
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
        this.ipcServer.registerHandler('startFromFile', this.handleStartFromFileCommand.bind(this));

        // Monitoring commands
        this.ipcServer.registerHandler('monit', this.handleMonitCommand.bind(this));
        this.ipcServer.registerHandler('show', this.handleShowCommand.bind(this));

        // Error handling commands
        this.ipcServer.registerHandler('errors', this.handleErrorsCommand.bind(this));
        this.ipcServer.registerHandler('errorStats', this.handleErrorStatsCommand.bind(this));

        // Performance and memory commands
        this.ipcServer.registerHandler('memoryStats', this.handleMemoryStatsCommand.bind(this));
        this.ipcServer.registerHandler('performanceStats', this.handlePerformanceStatsCommand.bind(this));
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
                const error = new InvalidConfigurationError(validation.errors, { config });
                await this.errorHandler.handleError(error);
                return createErrorResponse(message.id, error.getUserMessage());
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
            // Handle the error through our error handler
            await this.errorHandler.handleError(error instanceof Error ? error : new Error(String(error)));
            const errorMessage = createUserFriendlyError(error instanceof Error ? error : new Error(String(error)));
            return createErrorResponse(message.id, errorMessage);
        }
    }

    /**
     * Handle stop process command
     */
    private async handleStopCommand(message: IPCMessage): Promise<IPCResponse> {
        try {
            const { identifier } = message.payload;

            if (!identifier) {
                return createErrorResponse(message.id, 'Process identifier is required');
            }

            // Check if this is a request to stop all instances of a process
            const processes = this.processManager.list();
            const matchingProcesses = processes.filter(p => 
                p.id === identifier || 
                p.id.startsWith(`${identifier}_`) ||
                (this.processConfigs.get(identifier.includes('_') ? identifier.split('_')[0] : identifier)?.name === identifier)
            );

            if (matchingProcesses.length === 0) {
                return createErrorResponse(message.id, `Process '${identifier}' not found`);
            }

            // Stop all matching processes
            const stopPromises = matchingProcesses.map(process => 
                this.processManager.stop(process.id)
            );
            
            await Promise.all(stopPromises);
            await this.saveState();

            const stoppedCount = matchingProcesses.length;
            const message_text = stoppedCount === 1 
                ? `Process '${identifier}' stopped successfully`
                : `Stopped ${stoppedCount} instances of process '${identifier}'`;

            return createSuccessResponse(message.id, {
                message: message_text,
                stoppedInstances: matchingProcesses.map(p => p.id)
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
            const { identifier } = message.payload;

            if (!identifier) {
                return createErrorResponse(message.id, 'Process identifier is required');
            }

            // Check if this is a request to restart all instances of a process
            const processes = this.processManager.list();
            const matchingProcesses = processes.filter(p => 
                p.id === identifier || 
                p.id.startsWith(`${identifier}_`) ||
                (this.processConfigs.get(identifier.includes('_') ? identifier.split('_')[0] : identifier)?.name === identifier)
            );

            if (matchingProcesses.length === 0) {
                return createErrorResponse(message.id, `Process '${identifier}' not found`);
            }

            // Restart all matching processes
            const restartPromises = matchingProcesses.map(process => 
                this.processManager.restart(process.id)
            );
            
            const restartedInstances = await Promise.all(restartPromises);
            await this.saveState();

            const restartedCount = restartedInstances.length;
            const message_text = restartedCount === 1 
                ? `Process '${identifier}' restarted successfully`
                : `Restarted ${restartedCount} instances of process '${identifier}'`;

            return createSuccessResponse(message.id, {
                message: message_text,
                instances: restartedInstances.map(instance => ({
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
            const { identifier, force } = message.payload;

            if (!identifier) {
                return createErrorResponse(message.id, 'Process identifier is required');
            }

            // Find the base configuration by ID or name
            let baseConfigId = identifier;
            let processConfig = this.processConfigs.get(identifier);
            
            // If not found by ID, search by name
            if (!processConfig) {
                for (const [configId, config] of this.processConfigs.entries()) {
                    if (config.name === identifier) {
                        baseConfigId = configId;
                        processConfig = config;
                        break;
                    }
                }
            }
            
            // Handle clustered process ID (e.g., "app_0" -> "app")
            if (!processConfig && identifier.includes('_')) {
                baseConfigId = identifier.split('_')[0];
                processConfig = this.processConfigs.get(baseConfigId);
            }

            // Find all matching processes (including clustered instances)
            const processes = this.processManager.list();
            const matchingProcesses = processes.filter(p => 
                p.id === identifier || 
                p.id === baseConfigId ||
                p.id.startsWith(`${baseConfigId}_`) ||
                (processConfig && p.id.startsWith(`${processConfig.id}_`))
            );
            
            // Check if we have a config or running processes for this identifier
            if (!processConfig && matchingProcesses.length === 0) {
                return createErrorResponse(message.id, `Process '${identifier}' not found`);
            }

            const stoppedInstances: string[] = [];
            let removedLogs = false;

            // Stop all running instances
            if (matchingProcesses.length > 0) {
                for (const process of matchingProcesses) {
                    try {
                        await this.processManager.stop(process.id);
                        stoppedInstances.push(process.id);
                    } catch (error) {
                        // Log error but continue with deletion
                        console.warn(`Warning: Failed to stop process ${process.id}: ${error}`);
                    }
                }
            }

            // Clean up log files for the process
            try {
                if (processConfig) {
                    await this.logManager.cleanupLogs(processConfig.id);
                    removedLogs = true;
                }
            } catch (error) {
                // Log error but continue with deletion
                console.warn(`Warning: Failed to cleanup logs for ${identifier}: ${error}`);
            }

            // Remove configuration from memory and persistent storage
            if (processConfig) {
                this.processConfigs.delete(baseConfigId);
            }

            // Stop monitoring for all instances
            for (const process of matchingProcesses) {
                this.monitorManager.stopMonitoring(process.id);
            }

            // Save updated state
            await this.saveState();

            const processName = processConfig?.name || identifier;
            const instanceCount = stoppedInstances.length;
            
            let message_text = `Process '${processName}' deleted successfully`;
            if (instanceCount > 0) {
                message_text += ` (stopped ${instanceCount} instance${instanceCount > 1 ? 's' : ''})`;
            }

            return createSuccessResponse(message.id, {
                message: message_text,
                processId: baseConfigId,
                processName: processName,
                stoppedInstances: stoppedInstances,
                removedLogs: removedLogs
            });
        } catch (error) {
            await this.errorHandler.handleError(error instanceof Error ? error : new Error(String(error)));
            const errorMessage = createUserFriendlyError(error instanceof Error ? error : new Error(String(error)));
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

            const configs = Array.from(this.processConfigs.values());
            
            if (configs.length === 0) {
                return createErrorResponse(message.id, 'No process configurations to save');
            }

            const validation = await this.configManager.saveEcosystemFile(filePath, configs);

            if (!validation.isValid) {
                return createErrorResponse(message.id, `Failed to save configuration:\n${validation.errors.join('\n')}`);
            }

            return createSuccessResponse(message.id, {
                message: `Configuration saved to ${filePath}`,
                processCount: configs.length,
                processes: configs.map(c => ({ id: c.id, name: c.name }))
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return createErrorResponse(message.id, errorMessage);
        }
    }

    /**
     * Handle start from ecosystem file command
     */
    private async handleStartFromFileCommand(message: IPCMessage): Promise<IPCResponse> {
        try {
            const { filePath, appName } = message.payload;

            if (!filePath) {
                return createErrorResponse(message.id, 'File path is required');
            }

            // Parse ecosystem configuration file
            const { config: ecosystemConfig, errors: parseErrors } = await this.configManager.parseEcosystemFile(filePath);

            if (parseErrors.length > 0) {
                return createErrorResponse(message.id, `Configuration file errors:\n${parseErrors.join('\n')}`);
            }

            if (ecosystemConfig.apps.length === 0) {
                return createErrorResponse(message.id, 'No valid app configurations found in file');
            }

            // If appName is specified, start only that app
            let appsToStart = ecosystemConfig.apps;
            if (appName) {
                appsToStart = ecosystemConfig.apps.filter(app => app.name === appName || app.id === appName);
                if (appsToStart.length === 0) {
                    return createErrorResponse(message.id, `App '${appName}' not found in configuration file`);
                }
            }

            const results = [];
            let successCount = 0;

            for (const config of appsToStart) {
                try {
                    // Check if process already exists
                    if (this.processConfigs.has(config.id)) {
                        results.push({
                            id: config.id,
                            name: config.name,
                            success: false,
                            error: `Process with id '${config.id}' already exists`
                        });
                        continue;
                    }

                    const instances = await this.processManager.start(config);
                    this.processConfigs.set(config.id, config);
                    successCount++;

                    results.push({
                        id: config.id,
                        name: config.name,
                        success: true,
                        instances: instances.length,
                        pids: instances.map(i => i.pid)
                    });
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    results.push({
                        id: config.id,
                        name: config.name,
                        success: false,
                        error: errorMessage
                    });
                }
            }

            await this.saveState();

            const message_text = appName 
                ? `Started app '${appName}' from ${filePath}`
                : `Started ${successCount}/${appsToStart.length} processes from ${filePath}`;

            return createSuccessResponse(message.id, {
                message: message_text,
                totalApps: appsToStart.length,
                successCount,
                results
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

            // Parse ecosystem configuration file
            const { config: ecosystemConfig, errors: parseErrors } = await this.configManager.parseEcosystemFile(filePath);

            if (parseErrors.length > 0) {
                return createErrorResponse(message.id, `Configuration file errors:\n${parseErrors.join('\n')}`);
            }

            if (ecosystemConfig.apps.length === 0) {
                return createErrorResponse(message.id, 'No valid app configurations found in file');
            }

            const results = [];
            let successCount = 0;

            for (const config of ecosystemConfig.apps) {
                try {
                    // Check if process already exists
                    if (this.processConfigs.has(config.id)) {
                        results.push({
                            id: config.id,
                            name: config.name,
                            success: false,
                            error: `Process with id '${config.id}' already exists`
                        });
                        continue;
                    }

                    const instances = await this.processManager.start(config);
                    this.processConfigs.set(config.id, config);
                    successCount++;

                    results.push({
                        id: config.id,
                        name: config.name,
                        success: true,
                        instances: instances.length,
                        pids: instances.map(i => i.pid)
                    });
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    results.push({
                        id: config.id,
                        name: config.name,
                        success: false,
                        error: errorMessage
                    });
                }
            }

            await this.saveState();

            const message_text = successCount > 0 
                ? `Successfully loaded ${successCount}/${ecosystemConfig.apps.length} processes from ${filePath}`
                : `Failed to load any processes from ${filePath}`;

            return createSuccessResponse(message.id, {
                message: message_text,
                totalApps: ecosystemConfig.apps.length,
                successCount,
                results
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return createErrorResponse(message.id, errorMessage);
        }
    }

    /**
     * Handle monit command - real-time monitoring
     */
    private async handleMonitCommand(message: IPCMessage): Promise<IPCResponse> {
        try {
            const processes = this.processManager.list();
            const systemInfo = await this.monitorManager.getSystemInfo();

            // Get metrics for all processes
            const processesWithMetrics = processes.map(process => {
                const config = this.processConfigs.get(process.id.split('_')[0]) || 
                              this.processConfigs.get(process.id);
                const metrics = this.monitorManager.getMetrics(process.id);

                return {
                    id: process.id,
                    name: config?.name || process.id,
                    status: process.status,
                    pid: process.pid,
                    script: config?.script,
                    cwd: config?.cwd,
                    instances: config?.instances || 1,
                    autorestart: config?.autorestart,
                    maxRestarts: config?.maxRestarts,
                    memoryLimit: config?.memoryLimit,
                    env: config?.env,
                    startTime: process.startTime,
                    restartCount: process.restartCount,
                    metrics: metrics
                };
            });

            return createSuccessResponse(message.id, {
                processes: processesWithMetrics,
                systemInfo: systemInfo
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return createErrorResponse(message.id, errorMessage);
        }
    }

    /**
     * Handle show command - detailed process information
     */
    private async handleShowCommand(message: IPCMessage): Promise<IPCResponse> {
        try {
            const { identifier } = message.payload;

            if (!identifier) {
                return createErrorResponse(message.id, 'Process identifier is required');
            }

            // Find the process
            const processes = this.processManager.list();
            let process = processes.find(p => {
                // Direct ID match
                if (p.id === identifier) return true;
                
                // Clustered process ID match (e.g., "app_0", "app_1")
                if (p.id.startsWith(`${identifier}_`)) return true;
                
                // Find by name - check all configs for matching name
                const baseId = p.id.includes('_') ? p.id.split('_')[0] : p.id;
                const config = this.processConfigs.get(baseId);
                if (config && config.name === identifier) return true;
                
                return false;
            });

            if (!process) {
                return createErrorResponse(message.id, `Process '${identifier}' not found`);
            }

            // Get process configuration
            const config = this.processConfigs.get(process.id.split('_')[0]) || 
                          this.processConfigs.get(process.id);

            // Get current metrics
            const metrics = this.monitorManager.getMetrics(process.id);

            // Get metrics history
            const history = this.monitorManager.getMetricsHistory(process.id);

            const processInfo = {
                id: process.id,
                name: config?.name || process.id,
                status: process.status,
                pid: process.pid,
                script: config?.script,
                cwd: config?.cwd,
                instances: config?.instances || 1,
                autorestart: config?.autorestart,
                maxRestarts: config?.maxRestarts,
                memoryLimit: config?.memoryLimit,
                env: config?.env,
                startTime: process.startTime,
                restartCount: process.restartCount
            };

            return createSuccessResponse(message.id, {
                process: processInfo,
                metrics: metrics,
                history: history
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
     * Handle errors command - get error history
     */
    private async handleErrorsCommand(message: IPCMessage): Promise<IPCResponse> {
        try {
            const { limit } = message.payload;
            const errors = this.errorHandler.getErrorHistory(limit);
            const processManagerErrors = this.processManager.getErrorHistory(limit);

            // Combine errors from daemon and process manager
            const allErrors = [...errors, ...processManagerErrors]
                .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
                .slice(0, limit || 50);

            return createSuccessResponse(message.id, {
                errors: allErrors,
                totalCount: allErrors.length
            });
        } catch (error) {
            await this.errorHandler.handleError(error instanceof Error ? error : new Error(String(error)));
            const errorMessage = createUserFriendlyError(error instanceof Error ? error : new Error(String(error)));
            return createErrorResponse(message.id, errorMessage);
        }
    }

    /**
     * Handle error stats command - get error statistics
     */
    private async handleErrorStatsCommand(message: IPCMessage): Promise<IPCResponse> {
        try {
            const daemonStats = this.errorHandler.getErrorStats();
            const processManagerStats = this.processManager.getErrorStats();

            // Combine statistics
            const combinedStats = {
                daemon: daemonStats,
                processManager: processManagerStats,
                combined: {
                    total: daemonStats.total + processManagerStats.total,
                    recent: daemonStats.recent + processManagerStats.recent,
                    byCategory: {} as Record<string, number>,
                    bySeverity: {} as Record<string, number>
                }
            };

            // Combine category counts
            const allCategories = new Set([
                ...Object.keys(daemonStats.byCategory),
                ...Object.keys(processManagerStats.byCategory)
            ]);
            for (const category of allCategories) {
                combinedStats.combined.byCategory[category] = 
                    (daemonStats.byCategory[category as any] || 0) + 
                    (processManagerStats.byCategory[category as any] || 0);
            }

            // Combine severity counts
            const allSeverities = new Set([
                ...Object.keys(daemonStats.bySeverity),
                ...Object.keys(processManagerStats.bySeverity)
            ]);
            for (const severity of allSeverities) {
                combinedStats.combined.bySeverity[severity] = 
                    (daemonStats.bySeverity[severity as any] || 0) + 
                    (processManagerStats.bySeverity[severity as any] || 0);
            }

            return createSuccessResponse(message.id, combinedStats);
        } catch (error) {
            await this.errorHandler.handleError(error instanceof Error ? error : new Error(String(error)));
            const errorMessage = createUserFriendlyError(error instanceof Error ? error : new Error(String(error)));
            return createErrorResponse(message.id, errorMessage);
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
     * Handle memory statistics command
     */
    private async handleMemoryStatsCommand(message: IPCMessage): Promise<IPCResponse> {
        try {
            const daemonMemory = this.memoryTracker.getMemoryStats();
            const logManagerMemory = this.logManager.getMemoryStats();
            const monitorManagerMemory = this.monitorManager.getMemoryStats();
            const configStoreMemory = this.processConfigs.getMemoryStats();
            const ipcStats = this.ipcServer.getConnectionStats();

            return createSuccessResponse(message.id, {
                daemon: daemonMemory,
                logManager: logManagerMemory,
                monitorManager: monitorManagerMemory,
                configStore: configStoreMemory,
                ipc: ipcStats,
                processMemory: process.memoryUsage()
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return createErrorResponse(message.id, errorMessage);
        }
    }

    /**
     * Handle performance statistics command
     */
    private async handlePerformanceStatsCommand(message: IPCMessage): Promise<IPCResponse> {
        try {
            const processes = this.processManager.list();
            const uptime = process.uptime();
            const memoryStats = this.memoryTracker.getMemoryStats();
            
            return createSuccessResponse(message.id, {
                daemon: {
                    uptime,
                    processCount: processes.length,
                    memoryUsage: memoryStats?.current || process.memoryUsage(),
                    connectionCount: this.ipcServer.getConnectionCount()
                },
                processes: processes.length,
                memory: memoryStats
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return createErrorResponse(message.id, errorMessage);
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

    /**
     * Optimize memory usage across all components
     */
    private optimizeMemory(): void {
        try {
            // Record memory measurement
            this.memoryTracker.recordMeasurement();
            
            // Optimize log manager memory
            this.logManager.optimizeMemory();
            
            // Optimize monitor manager memory
            this.monitorManager.optimizeMemory();
            
            // Force garbage collection if memory usage is high
            const memoryStats = this.memoryTracker.getMemoryStats();
            if (memoryStats && memoryStats.current.heapUsed > 100 * 1024 * 1024) { // > 100MB
                this.gcOptimizer.performOptimizedGC();
            }
        } catch (error) {
            console.error('Error during memory optimization:', error);
        }
    }
}