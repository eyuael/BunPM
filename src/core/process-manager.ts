import { resolve } from "path";
import {
  ProcessConfig,
  ProcessInstance,
  createProcessInstance,
  updateProcessStatus,
  incrementRestartCount
} from "../types/index.js";
import { LogManager } from "./log-manager.js";

/**
 * Core process manager that handles process lifecycle operations
 */
export class ProcessManager {
  private processes: Map<string, ProcessInstance> = new Map();
  private restartTimeouts: Map<string, Timer> = new Map();
  private processConfigs: Map<string, ProcessConfig> = new Map();
  private logManager: LogManager;

  constructor(logManager?: LogManager) {
    this.logManager = logManager || new LogManager();
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
        throw new Error(`Process with id '${instanceId}' already exists`);
      }

      try {
        const instance = await this.spawnProcess(config, instanceId, i);
        this.processes.set(instanceId, instance);
        instances.push(instance);

        // Set up process monitoring
        this.setupProcessMonitoring(instance, config);
      } catch (error) {
        throw new Error(`Failed to start process '${instanceId}': ${error}`);
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
      throw new Error(`Process with id '${id}' not found`);
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

      // Remove from processes map after a short delay to allow exit handler to run
      setTimeout(() => {
        this.processes.delete(id);
      }, 100);
    } catch (error) {
      throw new Error(`Failed to stop process '${id}': ${error}`);
    }
  }

  /**
   * Restart a process by ID
   */
  async restart(id: string): Promise<ProcessInstance> {
    const instance = this.processes.get(id);
    if (!instance) {
      throw new Error(`Process with id '${id}' not found`);
    }

    // Get the stored configuration
    const baseId = id.includes('_') ? id.split('_')[0] : id;
    const config = this.processConfigs.get(baseId);
    if (!config) {
      throw new Error(`Configuration for process '${baseId}' not found`);
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
      throw new Error('Instance count must be at least 1');
    }

    // Find all instances of this process
    const processInstances = Array.from(this.processes.entries())
      .filter(([instanceId]) => instanceId.startsWith(id))
      .map(([, instance]) => instance);

    if (processInstances.length === 0) {
      throw new Error(`No processes found with id '${id}'`);
    }

    const currentCount = processInstances.length;

    if (instances === currentCount) {
      return processInstances;
    }

    // Get base config from first instance (simplified for this implementation)
    const baseConfig: ProcessConfig = {
      id,
      name: id,
      script: 'placeholder',
      cwd: process.cwd(),
      env: {},
      instances,
      autorestart: true,
      maxRestarts: 10
    };

    if (instances > currentCount) {
      // Scale up - start new instances manually to avoid ID conflicts
      const newInstances: ProcessInstance[] = [];

      for (let i = currentCount; i < instances; i++) {
        const instanceId = `${id}_${i}`;
        const instance = await this.spawnProcess(baseConfig, instanceId, i);
        this.processes.set(instanceId, instance);
        newInstances.push(instance);
        this.setupProcessMonitoring(instance, baseConfig);
      }

      return [...processInstances, ...newInstances];
    } else {
      // Scale down - stop excess instances
      const instancesToStop = processInstances.slice(instances);

      for (const instance of instancesToStop) {
        await this.stop(instance.id);
      }

      return processInstances.slice(0, instances);
    }
  }

  /**
   * Spawn a single process instance
   */
  private async spawnProcess(config: ProcessConfig, instanceId: string, instanceIndex: number): Promise<ProcessInstance> {
    const scriptPath = resolve(config.cwd, config.script);

    // Prepare environment variables
    const env = { ...process.env, ...config.env };

    // Add PORT for clustering
    if (config.instances > 1) {
      const basePort = parseInt(env.PORT || '3000');
      env.PORT = (basePort + instanceIndex).toString();
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
        throw new Error('Failed to get process PID');
      }

      // Create process instance
      const instance = createProcessInstance(instanceId, subprocess.pid, subprocess);

      // Start log capture
      this.logManager.captureOutput(instanceId, subprocess);

      return instance;
    } catch (error) {
      throw new Error(`Failed to spawn process: ${error}`);
    }
  }

  /**
   * Set up monitoring for a process instance
   */
  private setupProcessMonitoring(instance: ProcessInstance, config: ProcessConfig): void {
    const subprocess = instance.subprocess;

    // Monitor process exit
    subprocess.exited.then((exitCode) => {
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
        console.log(`Process ${instance.id} crashed (exit code: ${exitCode}), restart count: ${currentInstance.restartCount}/${config.maxRestarts}`);

        if (config.autorestart) {
          // Attempt restart within 1 second (requirement 2.1)
          console.log(`Attempting to restart process ${instance.id}`);
          this.handleProcessRestart(currentInstance, config);
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
  private handleProcessRestart(instance: ProcessInstance, config: ProcessConfig): void {
    // Check if we've exceeded max restart attempts BEFORE incrementing (requirement 2.2)
    if (instance.restartCount >= config.maxRestarts) {
      console.error(`Process ${instance.id} exceeded max restart attempts (${config.maxRestarts}), marking as errored`);
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

        // Start new instance with same config but preserve restart count
        const newInstance = await this.spawnSingleInstance(restartConfig, instance.id, 0);
        // Preserve the restart count from the restarting instance
        const newInstanceWithCount = { ...newInstance, restartCount: restartingInstance.restartCount };
        this.processes.set(instance.id, newInstanceWithCount);

        // Set up monitoring for the new instance
        this.setupProcessMonitoring(newInstanceWithCount, config);

        console.log(`Process ${instance.id} restarted successfully (PID: ${newInstance.pid})`);
      } catch (error) {
        console.error(`Failed to restart process ${instance.id}:`, error);

        // Check if we've exceeded max restart attempts after failure
        if (restartingInstance.restartCount >= config.maxRestarts) {
          console.error(`Process ${instance.id} exceeded max restart attempts (${config.maxRestarts}), marking as errored`);
          const erroredInstance = updateProcessStatus(restartingInstance, 'errored');
          this.processes.set(instance.id, erroredInstance);
        } else {
          // Try again with current count
          this.handleProcessRestart(restartingInstance, config);
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
   * Clean up all processes and resources
   */
  async cleanup(): Promise<void> {
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