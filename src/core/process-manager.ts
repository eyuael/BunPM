import { resolve } from "path";
import { 
  ProcessConfig, 
  ProcessInstance,
  createProcessInstance,
  updateProcessStatus,
  incrementRestartCount
} from "../types/index.js";

/**
 * Core process manager that handles process lifecycle operations
 */
export class ProcessManager {
  private processes: Map<string, ProcessInstance> = new Map();
  private restartTimeouts: Map<string, Timer> = new Map();

  /**
   * Start a process based on configuration
   */
  async start(config: ProcessConfig): Promise<ProcessInstance[]> {
    const instances: ProcessInstance[] = [];

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

    // Update status to stopped to prevent auto-restart
    const stoppedInstance = updateProcessStatus(instance, 'stopped');
    this.processes.set(id, stoppedInstance);

    try {
      // Attempt graceful shutdown first
      instance.subprocess.kill('SIGTERM');
      
      // Wait a bit for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Force kill if still running
      if (!instance.subprocess.killed) {
        instance.subprocess.kill('SIGKILL');
      }

      // Remove from processes map
      this.processes.delete(id);
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

    // Get the original config (we'll need to store this separately in a real implementation)
    // For now, we'll create a basic config from the instance
    const config: ProcessConfig = {
      id: instance.id,
      name: instance.id,
      script: 'placeholder', // This would need to be stored
      cwd: process.cwd(),
      env: {},
      instances: 1,
      autorestart: true,
      maxRestarts: 10
    };

    // Stop the current process
    await this.stop(id);

    // Start a new instance
    const instances = await this.start(config);
    return instances[0];
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
      if (!currentInstance) return;

      // If process was manually stopped, don't restart
      if (currentInstance.status === 'stopped') {
        return;
      }

      // Handle process exit
      if (exitCode === 0) {
        // Clean exit - mark as stopped
        const stoppedInstance = updateProcessStatus(currentInstance, 'stopped');
        this.processes.set(instance.id, stoppedInstance);
        this.processes.delete(instance.id);
      } else {
        // Unexpected exit - handle restart if enabled
        if (config.autorestart && currentInstance.restartCount < config.maxRestarts) {
          this.handleProcessRestart(currentInstance, config);
        } else {
          // Mark as errored
          const erroredInstance = updateProcessStatus(currentInstance, 'errored');
          this.processes.set(instance.id, erroredInstance);
        }
      }
    }).catch((error) => {
      console.error(`Error monitoring process ${instance.id}:`, error);
    });
  }

  /**
   * Handle automatic process restart
   */
  private handleProcessRestart(instance: ProcessInstance, config: ProcessConfig): void {
    // Update status to restarting
    const restartingInstance = updateProcessStatus(
      incrementRestartCount(instance), 
      'restarting'
    );
    this.processes.set(instance.id, restartingInstance);

    // Calculate backoff delay (exponential backoff)
    const backoffDelay = Math.min(1000 * Math.pow(2, restartingInstance.restartCount), 30000);

    // Schedule restart
    const timeout = setTimeout(async () => {
      this.restartTimeouts.delete(instance.id);
      
      try {
        // Remove the failed instance
        this.processes.delete(instance.id);
        
        // Start new instance
        const newInstances = await this.start(config);
        console.log(`Process ${instance.id} restarted successfully`);
      } catch (error) {
        console.error(`Failed to restart process ${instance.id}:`, error);
        
        // Mark as errored
        const erroredInstance = updateProcessStatus(restartingInstance, 'errored');
        this.processes.set(instance.id, erroredInstance);
      }
    }, backoffDelay);

    this.restartTimeouts.set(instance.id, timeout);
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
  }
}