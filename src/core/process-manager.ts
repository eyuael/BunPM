import { resolve } from "path";
import {
  ProcessConfig,
  ProcessInstance,
  createProcessInstance,
  updateProcessStatus,
  incrementRestartCount
} from "../types/index.js";
import { LogManager } from "./log-manager.js";
import { MonitorManager } from "./monitor-manager.js";
import {
  ErrorHandler,
  ProcessStartupError,
  ProcessCrashError,
  ProcessRestartLimitError,
  ProcessMemoryLimitError,
  FileNotFoundError,
  createUserFriendlyError
} from "./error-handler.js";

/**
 * Core process manager that handles process lifecycle operations
 */
export class ProcessManager {
  private processes: Map<string, ProcessInstance> = new Map();
  private restartTimeouts: Map<string, Timer> = new Map();
  private processConfigs: Map<string, ProcessConfig> = new Map();
  private logManager: LogManager;
  private monitorManager?: MonitorManager;
  private memoryCheckInterval?: Timer;
  private errorHandler: ErrorHandler;

  constructor(logManager?: LogManager, monitorManager?: MonitorManager) {
    this.logManager = logManager || new LogManager();
    this.monitorManager = monitorManager;
    this.errorHandler = new ErrorHandler();

    // Set up periodic memory limit checking (every 30 seconds)
    if (this.monitorManager) {
      this.memoryCheckInterval = setInterval(() => {
        this.checkMemoryLimits();
      }, 30000);
    }
  }

  /**
   * Start a process based on configuration
   */
  async start(config: ProcessConfig): Promise<ProcessInstance[]> {
    const instances: ProcessInstance[] = [];

    // Store the configuration for restart purposes
    this.processConfigs.set(config.id, config);

    for (let i = 0; i < config.instances; i++) {
      const instanceId = config.instances > 1 ? `${config.id}_${i}` : config.id;

      // Check if process already exists
      if (this.processes.has(instanceId)) {
        const error = new ProcessStartupError(
          instanceId,
          'Process already exists',
          { existingProcess: true }
        );
        await this.errorHandler.handleError(error);
        throw error;
      }

      try {
        const instance = await this.spawnProcess(config, instanceId, i);
        this.processes.set(instanceId, instance);
        instances.push(instance);

        // Set up process monitoring
        this.setupProcessMonitoring(instance, config);

        // Start resource monitoring
        if (this.monitorManager) {
          this.monitorManager.startMonitoring(instanceId, instance.pid, instance.startTime);
        }
      } catch (error) {
        const processError = new ProcessStartupError(
          instanceId,
          error instanceof Error ? error.message : String(error),
          { originalError: error, config }
        );
        await this.errorHandler.handleError(processError, this);
        throw processError;
      }
    }

    return instances;
  }

  /**
   * Stop a process by ID
   */
  async stop(id: string): Promise<void> {
    const instance = this.processes.get(id);
    if (!instance) {
      const error = new ProcessStartupError(id, 'Process not found', { operation: 'stop' });
      await this.errorHandler.handleError(error);
      throw error;
    }

    // Clear any restart timeout
    const timeout = this.restartTimeouts.get(id);
    if (timeout) {
      clearTimeout(timeout);
      this.restartTimeouts.delete(id);
    }

    // Update status to stopped to prevent auto-restart (requirement 2.4)
    const stoppedInstance = updateProcessStatus(instance, 'stopped');
    this.processes.set(id, stoppedInstance);

    try {
      // Attempt graceful shutdown first
      instance.subprocess.kill('SIGTERM');

      // Wait a bit for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 100)); // Short grace period for tests

      // Force kill if still running
      if (!instance.subprocess.killed) {
        console.log(`Process ${id} did not respond to SIGTERM, sending SIGKILL`);
        instance.subprocess.kill('SIGKILL');
      }

      // Stop log capture
      this.logManager.stopCapture(id);

      // Stop resource monitoring
      if (this.monitorManager) {
        this.monitorManager.stopMonitoring(id);
      }

      // Remove from processes map after a short delay to allow exit handler to run
      setTimeout(() => {
        this.processes.delete(id);
      }, 100);
    } catch (error) {
      const processError = new ProcessStartupError(
        id,
        error instanceof Error ? error.message : String(error),
        { operation: 'stop', originalError: error }
      );
      await this.errorHandler.handleError(processError);
      throw processError;
    }
  }

  /**
   * Restart a process by ID
   */
  async restart(id: string): Promise<ProcessInstance> {
    const instance = this.processes.get(id);
    if (!instance) {
      const error = new ProcessStartupError(id, 'Process not found', { operation: 'restart' });
      await this.errorHandler.handleError(error);
      throw error;
    }

    // Get the stored configuration
    const baseId = id.includes('_') ? id.split('_')[0] : id;
    const config = this.processConfigs.get(baseId);
    if (!config) {
      const error = new ProcessStartupError(
        baseId,
        'Configuration not found',
        { operation: 'restart', processId: id }
      );
      await this.errorHandler.handleError(error);
      throw error;
    }

    // Stop the current process
    await this.stop(id);

    // Wait a moment for cleanup
    await new Promise(resolve => setTimeout(resolve, 100));

    // Start a new instance with reset restart count
    const instanceIndex = id.includes('_') ? parseInt(id.split('_')[1]) : 0;
    const newInstance = await this.spawnProcess(config, id, instanceIndex);
    this.processes.set(id, newInstance);

    // Set up monitoring for the new instance
    this.setupProcessMonitoring(newInstance, config);

    // Start resource monitoring for the new instance
    if (this.monitorManager) {
      this.monitorManager.startMonitoring(id, newInstance.pid, newInstance.startTime);
    }

    return newInstance;
  }

  /**
   * List all managed processes
   */
  list(): ProcessInstance[] {
    return Array.from(this.processes.values());
  }

  /**
   * Get a specific process by ID
   */
  get(id: string): ProcessInstance | undefined {
    return this.processes.get(id);
  }

  /**
   * Get the configuration for a process
   */
  getConfig(id: string): ProcessConfig | undefined {
    const baseId = id.includes('_') ? id.split('_')[0] : id;
    return this.processConfigs.get(baseId);
  }

  /**
   * Check if a process has autorestart enabled
   */
  isAutorestartEnabled(id: string): boolean {
    const config = this.getConfig(id);
    return config?.autorestart ?? true;
  }

  /**
   * Get restart statistics for a process
   */
  getRestartStats(id: string): { restartCount: number; maxRestarts: number; canRestart: boolean } | undefined {
    const instance = this.get(id);
    const config = this.getConfig(id);

    if (!instance || !config) {
      return undefined;
    }

    return {
      restartCount: instance.restartCount,
      maxRestarts: config.maxRestarts,
      canRestart: config.autorestart && instance.restartCount < config.maxRestarts
    };
  }

  /**
   * Scale a process to a specific number of instances
   */
  async scale(id: string, instances: number): Promise<ProcessInstance[]> {
    if (instances < 1) {
      const error = new ProcessStartupError(
        id,
        'Invalid instance count',
        { operation: 'scale', instances, reason: 'Instance count must be at least 1' }
      );
      await this.errorHandler.handleError(error);
      throw error;
    }

    // Find the base process ID (remove instance suffix if present)
    const baseId = id.includes('_') ? id.split('_')[0] : id;
    
    // Find all instances of this process (both single instance and clustered)
    const processInstances = Array.from(this.processes.entries())
      .filter(([instanceId]) => {
        // Match exact ID for single instance or base ID for clustered instances
        return instanceId === baseId || instanceId.startsWith(`${baseId}_`);
      })
      .map(([, instance]) => instance);

    if (processInstances.length === 0) {
      const error = new ProcessStartupError(
        id,
        'Process not found',
        { operation: 'scale', instances }
      );
      await this.errorHandler.handleError(error);
      throw error;
    }

    const currentCount = processInstances.length;

    if (instances === currentCount) {
      return processInstances;
    }

    // Get the stored configuration for this process
    const config = this.processConfigs.get(baseId);
    if (!config) {
      const error = new ProcessStartupError(
        baseId,
        'Configuration not found',
        { operation: 'scale', processId: id, instances }
      );
      await this.errorHandler.handleError(error);
      throw error;
    }

    // Update the config instances count
    const updatedConfig = { ...config, instances };
    this.processConfigs.set(baseId, updatedConfig);

    if (instances > currentCount) {
      // Scale up - start new instances
      const newInstances: ProcessInstance[] = [];

      // If scaling from 1 to multiple instances, rename the existing instance
      if (currentCount === 1 && instances > 1) {
        const existingInstance = processInstances[0];
        if (existingInstance.id === baseId) {
          // Rename existing instance to include _0 suffix
          this.processes.delete(baseId);
          const renamedInstance = { ...existingInstance, id: `${baseId}_0` };
          this.processes.set(`${baseId}_0`, renamedInstance);
          processInstances[0] = renamedInstance;
        }
      }

      for (let i = currentCount; i < instances; i++) {
        const instanceId = instances > 1 ? `${baseId}_${i}` : baseId;
        const instance = await this.spawnProcess(updatedConfig, instanceId, i);
        this.processes.set(instanceId, instance);
        newInstances.push(instance);
        this.setupProcessMonitoring(instance, updatedConfig);

        // Start resource monitoring for new instance
        if (this.monitorManager) {
          this.monitorManager.startMonitoring(instanceId, instance.pid, instance.startTime);
        }
      }

      return [...processInstances, ...newInstances];
    } else {
      // Scale down - stop excess instances
      // Sort instances to stop the highest numbered ones first
      const sortedInstances = processInstances.sort((a, b) => {
        const aIndex = a.id.includes('_') ? parseInt(a.id.split('_')[1] || '0') : 0;
        const bIndex = b.id.includes('_') ? parseInt(b.id.split('_')[1] || '0') : 0;
        return bIndex - aIndex; // Descending order
      });

      const instancesToStop = sortedInstances.slice(0, currentCount - instances);
      const remainingInstances = sortedInstances.slice(currentCount - instances);

      // Stop instances sequentially to avoid race conditions
      for (const instance of instancesToStop) {
        await this.stop(instance.id);
        // Wait a moment for the process to be fully removed
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // If scaling down to 1 instance, rename the remaining instance to remove suffix
      if (instances === 1 && remainingInstances.length === 1) {
        const remainingInstance = remainingInstances[0];
        if (remainingInstance.id.includes('_')) {
          // Remove the old instance and add it with the base ID
          this.processes.delete(remainingInstance.id);
          const renamedInstance = { ...remainingInstance, id: baseId };
          this.processes.set(baseId, renamedInstance);
          return [renamedInstance];
        }
      }

      return remainingInstances;
    }
  }

  /**
   * Spawn a single process instance
   */
  private async spawnProcess(config: ProcessConfig, instanceId: string, instanceIndex: number): Promise<ProcessInstance> {
    const scriptPath = resolve(config.cwd, config.script);

    // Check if script file exists
    try {
      const file = Bun.file(scriptPath);
      if (!(await file.exists())) {
        throw new FileNotFoundError(scriptPath, { processId: instanceId, config });
      }
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        await this.errorHandler.handleError(error);
        throw error;
      }
      // Handle other file access errors
      const fileError = new FileNotFoundError(
        scriptPath,
        { processId: instanceId, config, originalError: error }
      );
      await this.errorHandler.handleError(fileError);
      throw fileError;
    }

    // Prepare environment variables
    const env = { ...process.env, ...config.env };

    // Add PORT for clustering (requirement 4.2)
    if (config.instances > 1) {
      const basePort = parseInt(env.PORT || '3000');
      env.PORT = (basePort + instanceIndex).toString();
      
      // Also set NODE_APP_INSTANCE for compatibility with other process managers
      env.NODE_APP_INSTANCE = instanceIndex.toString();
    }

    try {
      // Spawn process using Bun.spawn()
      const subprocess = Bun.spawn({
        cmd: ['bun', scriptPath],
        cwd: config.cwd,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore'
      });

      // Ensure we have a valid PID
      if (!subprocess.pid) {
        const error = new ProcessStartupError(
          instanceId,
          'Failed to get process PID',
          { config, scriptPath }
        );
        await this.errorHandler.handleError(error);
        throw error;
      }

      // Create process instance
      const instance = createProcessInstance(instanceId, subprocess.pid, subprocess);

      // Start log capture
      this.logManager.captureOutput(instanceId, subprocess);

      return instance;
    } catch (error) {
      const processError = new ProcessStartupError(
        instanceId,
        error instanceof Error ? error.message : String(error),
        { config, scriptPath, originalError: error }
      );
      await this.errorHandler.handleError(processError);
      throw processError;
    }
  }

  /**
   * Check memory limits for all processes and restart if necessary
   */
  private checkMemoryLimits(): void {
    if (!this.monitorManager) {
      return;
    }

    // Build memory limits map for efficient checking
    const memoryLimits = new Map<string, number>();
    for (const [instanceId] of this.processes) {
      const config = this.getConfig(instanceId);
      if (config && config.memoryLimit) {
        memoryLimits.set(instanceId, config.memoryLimit);
      }
    }

    // Check all processes at once
    const violatingProcesses = this.monitorManager.checkAllMemoryLimits(memoryLimits);

    // Handle each violating process
    for (const instanceId of violatingProcesses) {
      const instance = this.processes.get(instanceId);
      const config = this.getConfig(instanceId);
      
      if (!instance || !config) {
        continue;
      }

      const currentMemory = this.monitorManager.getCurrentMemoryUsage(instanceId);
      
      // Create memory limit error
      const memoryError = new ProcessMemoryLimitError(
        instanceId,
        currentMemory,
        config.memoryLimit,
        { restartCount: instance.restartCount }
      );
      
      // Handle the error (this will log it appropriately)
      this.errorHandler.handleError(memoryError, this).then(result => {
        if (result.recovered) {
          console.log(`Memory limit recovery initiated for process ${instanceId}`);
        }
      });
      
      // Update restart count for monitoring
      if (this.monitorManager) {
        this.monitorManager.updateRestartCount(instanceId, instance.restartCount + 1);
      }

      // Restart the process due to memory limit violation (requirement 2.5)
      this.restartDueToMemoryLimit(instanceId).catch(error => {
        this.errorHandler.handleError(error instanceof Error ? error : new Error(String(error)));
      });
    }
  }

  /**
   * Restart a process specifically due to memory limit violation
   */
   private async restartDueToMemoryLimit(instanceId: string): Promise<void> {
    const instance = this.processes.get(instanceId);
    const config = this.getConfig(instanceId);
    
    if (!instance || !config) {
      const error = new ProcessStartupError(
        instanceId,
        'Process not found for memory limit restart',
        { operation: 'memory-limit-restart' }
      );
      await this.errorHandler.handleError(error);
      throw error;
    }

    // Check if we can still restart (respect maxRestarts limit)
    if (instance.restartCount >= config.maxRestarts) {
      const error = new ProcessRestartLimitError(
        instanceId,
        config.maxRestarts,
        { reason: 'memory-limit-exceeded', restartCount: instance.restartCount }
      );
      await this.errorHandler.handleError(error);
      
      const erroredInstance = updateProcessStatus(instance, 'errored');
      this.processes.set(instanceId, erroredInstance);
      return;
    }

    // Increment restart count and mark as restarting
    const restartingInstance = updateProcessStatus(
      incrementRestartCount(instance),
      'restarting'
    );
    this.processes.set(instanceId, restartingInstance);

    try {
      // Stop the current process
      instance.subprocess.kill('SIGTERM');
      
      // Wait for process to exit
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Force kill if still running
      if (!instance.subprocess.killed) {
        instance.subprocess.kill('SIGKILL');
      }

      // Stop log capture and monitoring for old process
      this.logManager.stopCapture(instanceId);
      if (this.monitorManager) {
        this.monitorManager.stopMonitoring(instanceId);
      }

      // Wait a moment for cleanup
      await new Promise(resolve => setTimeout(resolve, 100));

      // Determine the instance index for proper PORT assignment
      const instanceIndex = instanceId.includes('_') ? 
        parseInt(instanceId.split('_')[1] || '0') : 0;

      // Start new instance
      const newInstance = await this.spawnProcess(config, instanceId, instanceIndex);
      
      // Preserve the restart count from the restarting instance
      const newInstanceWithCount = { ...newInstance, restartCount: restartingInstance.restartCount };
      this.processes.set(instanceId, newInstanceWithCount);

      // Set up monitoring for the new instance
      this.setupProcessMonitoring(newInstanceWithCount, config);

      // Start resource monitoring for restarted instance
      if (this.monitorManager) {
        this.monitorManager.startMonitoring(instanceId, newInstance.pid, newInstance.startTime);
      }

      console.log(`Process ${instanceId} restarted successfully due to memory limit (PID: ${newInstance.pid})`);
    } catch (error) {
      console.error(`Failed to restart process ${instanceId} due to memory limit:`, error);
      
      // Mark as errored if restart failed
      const erroredInstance = updateProcessStatus(restartingInstance, 'errored');
      this.processes.set(instanceId, erroredInstance);
    }
  }

  /**
   * Set up monitoring for a process instance
   */
  private setupProcessMonitoring(instance: ProcessInstance, config: ProcessConfig): void {
    const subprocess = instance.subprocess;

    // Monitor process exit
    subprocess.exited.then(async (exitCode) => {
      const currentInstance = this.processes.get(instance.id);
      if (!currentInstance) {
        console.log(`Process ${instance.id} exited but no longer tracked (exit code: ${exitCode})`);
        return;
      }

      console.log(`Process ${instance.id} exited with code ${exitCode}, status: ${currentInstance.status}`);

      // If process was manually stopped, don't restart (requirement 2.4)
      if (currentInstance.status === 'stopped') {
        console.log(`Process ${instance.id} was manually stopped, not restarting`);
        this.processes.delete(instance.id);
        return;
      }

      // Handle process exit based on exit code
      if (exitCode === 0) {
        // Clean exit - mark as stopped and don't restart
        console.log(`Process ${instance.id} exited cleanly, marking as stopped`);
        const stoppedInstance = updateProcessStatus(currentInstance, 'stopped');
        this.processes.set(instance.id, stoppedInstance);
        // Clean exit means intentional shutdown, remove from tracking
        setTimeout(() => this.processes.delete(instance.id), 100);
      } else {
        // Unexpected exit - handle restart if enabled (requirement 2.1)
        const crashError = new ProcessCrashError(
          instance.id,
          exitCode,
          undefined,
          { restartCount: currentInstance.restartCount, maxRestarts: config.maxRestarts }
        );

        // Handle the crash error
        this.errorHandler.handleError(crashError, this).then(result => {
          if (result.recovered) {
            console.log(`Process crash recovery initiated for ${instance.id}`);
          }
        });

        if (config.autorestart) {
          // Attempt restart within 1 second (requirement 2.1)
          console.log(`Attempting to restart process ${instance.id}`);
          await this.handleProcessRestart(currentInstance, config);
        } else {
          // Autorestart disabled (requirement 2.3)
          console.log(`Process ${instance.id} crashed but autorestart is disabled, marking as errored`);
          const erroredInstance = updateProcessStatus(currentInstance, 'errored');
          this.processes.set(instance.id, erroredInstance);
        }
      }
    }).catch((error) => {
      console.error(`Error monitoring process ${instance.id}:`, error);

      // On monitoring error, mark process as errored
      const currentInstance = this.processes.get(instance.id);
      if (currentInstance) {
        const erroredInstance = updateProcessStatus(currentInstance, 'errored');
        this.processes.set(instance.id, erroredInstance);
      }
    });
  }

  /**
   * Handle automatic process restart with exponential backoff
   */
  private async handleProcessRestart(instance: ProcessInstance, config: ProcessConfig): Promise<void> {
    // Check if we've exceeded max restart attempts BEFORE incrementing (requirement 2.2)
    if (instance.restartCount >= config.maxRestarts) {
      const error = new ProcessRestartLimitError(
        instance.id,
        config.maxRestarts,
        { restartCount: instance.restartCount }
      );
      await this.errorHandler.handleError(error);
      
      const erroredInstance = updateProcessStatus(instance, 'errored');
      this.processes.set(instance.id, erroredInstance);
      return;
    }

    // Update status to restarting and increment restart count
    const restartingInstance = updateProcessStatus(
      incrementRestartCount(instance),
      'restarting'
    );
    this.processes.set(instance.id, restartingInstance);

    // Calculate backoff delay (exponential backoff with jitter)
    // Start with 1 second base delay, max 30 seconds
    const baseDelay = 1000; // 1 second base as per requirement 2.1
    const maxDelay = 30000; // 30 seconds max
    const exponentialDelay = baseDelay * Math.pow(2, Math.min(restartingInstance.restartCount - 1, 5));
    const jitter = Math.random() * 0.1 * exponentialDelay; // Add 10% jitter
    const backoffDelay = Math.min(exponentialDelay + jitter, maxDelay);

    console.log(`Scheduling restart for process ${instance.id} (attempt ${restartingInstance.restartCount}/${config.maxRestarts}) in ${Math.round(backoffDelay)}ms`);

    // Schedule restart
    const timeout = setTimeout(async () => {
      this.restartTimeouts.delete(instance.id);

      try {
        // Create new instance config for restart
        const restartConfig = { ...config };

        // Remove the failed instance from tracking
        this.processes.delete(instance.id);

        // Determine the instance index for proper PORT assignment
        const instanceIndex = instance.id.includes('_') ? 
          parseInt(instance.id.split('_')[1] || '0') : 0;

        // Start new instance with same config but preserve restart count (requirement 4.4)
        const newInstance = await this.spawnSingleInstance(restartConfig, instance.id, instanceIndex);
        // Preserve the restart count from the restarting instance
        const newInstanceWithCount = { ...newInstance, restartCount: restartingInstance.restartCount };
        this.processes.set(instance.id, newInstanceWithCount);

        // Set up monitoring for the new instance
        this.setupProcessMonitoring(newInstanceWithCount, config);

        // Start resource monitoring for restarted instance
        if (this.monitorManager) {
          this.monitorManager.startMonitoring(instance.id, newInstance.pid, newInstance.startTime);
        }

        console.log(`Process ${instance.id} restarted successfully (PID: ${newInstance.pid})`);
      } catch (error) {
        const restartError = new ProcessStartupError(
          instance.id,
          error instanceof Error ? error.message : String(error),
          { operation: 'auto-restart', restartCount: restartingInstance.restartCount, originalError: error }
        );
        await this.errorHandler.handleError(restartError);

        // Check if we've exceeded max restart attempts after failure
        if (restartingInstance.restartCount >= config.maxRestarts) {
          const limitError = new ProcessRestartLimitError(
            instance.id,
            config.maxRestarts,
            { restartCount: restartingInstance.restartCount, reason: 'restart-failed' }
          );
          await this.errorHandler.handleError(limitError);
          
          const erroredInstance = updateProcessStatus(restartingInstance, 'errored');
          this.processes.set(instance.id, erroredInstance);
        } else {
          // Try again with current count
          await this.handleProcessRestart(restartingInstance, config);
        }
      }
    }, backoffDelay);

    this.restartTimeouts.set(instance.id, timeout);
  }

  /**
   * Spawn a single process instance (extracted for restart logic)
   */
  private async spawnSingleInstance(config: ProcessConfig, instanceId: string, instanceIndex: number): Promise<ProcessInstance> {
    return this.spawnProcess(config, instanceId, instanceIndex);
  }

  /**
   * Get error handler for external access
   */
  getErrorHandler(): ErrorHandler {
    return this.errorHandler;
  }

  /**
   * Get error statistics
   */
  getErrorStats() {
    return this.errorHandler.getErrorStats();
  }

  /**
   * Get recent error history
   */
  getErrorHistory(limit?: number) {
    return this.errorHandler.getErrorHistory(limit);
  }

  /**
   * Clean up all processes and resources
   */
  async cleanup(): Promise<void> {
    // Clear memory check interval
    if (this.memoryCheckInterval) {
      clearInterval(this.memoryCheckInterval);
      this.memoryCheckInterval = undefined;
    }

    // Clear all restart timeouts
    for (const timeout of this.restartTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.restartTimeouts.clear();

    // Stop all processes
    const stopPromises = Array.from(this.processes.keys()).map(id =>
      this.stop(id).catch(error =>
        console.error(`Error stopping process ${id}:`, error)
      )
    );

    await Promise.all(stopPromises);
    this.processes.clear();
    this.processConfigs.clear();
  }
}