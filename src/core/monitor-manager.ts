import { ProcessMetrics } from "../types/index.js";

/**
 * System resource information
 */
interface SystemInfo {
  totalMemory: number;
  freeMemory: number;
  cpuCount: number;
}

/**
 * Process resource usage data
 */
interface ProcessResourceUsage {
  pid: number;
  cpu: number;
  memory: number;
  startTime: Date;
}

/**
 * Monitor manager for tracking process resource usage
 */
export class MonitorManager {
  private monitoredProcesses = new Map<string, ProcessResourceUsage>();
  private metricsHistory = new Map<string, ProcessMetrics[]>();
  private monitoringIntervals = new Map<string, Timer>();
  private readonly MONITORING_INTERVAL = 5000; // 5 seconds
  private readonly MAX_HISTORY_LENGTH = 100;

  /**
   * Start monitoring a process
   */
  startMonitoring(processId: string, pid: number, startTime: Date = new Date()): void {
    // Stop existing monitoring if any
    this.stopMonitoring(processId);

    // Initialize process data
    this.monitoredProcesses.set(processId, {
      pid,
      cpu: 0,
      memory: 0,
      startTime
    });

    // Initialize metrics history
    if (!this.metricsHistory.has(processId)) {
      this.metricsHistory.set(processId, []);
    }

    // Start monitoring interval
    const interval = setInterval(async () => {
      await this.collectMetrics(processId);
    }, this.MONITORING_INTERVAL);

    this.monitoringIntervals.set(processId, interval);

    // Collect initial metrics
    this.collectMetrics(processId);
  }

  /**
   * Stop monitoring a process
   */
  stopMonitoring(processId: string): void {
    const interval = this.monitoringIntervals.get(processId);
    if (interval) {
      clearInterval(interval);
      this.monitoringIntervals.delete(processId);
    }

    this.monitoredProcesses.delete(processId);
  }

  /**
   * Get current metrics for a process
   */
  getMetrics(processId: string): ProcessMetrics | null {
    const processData = this.monitoredProcesses.get(processId);
    if (!processData) {
      return null;
    }

    const uptime = Math.floor((Date.now() - processData.startTime.getTime()) / 1000);
    const history = this.metricsHistory.get(processId) || [];
    const restarts = this.getRestartCount(processId);

    return {
      cpu: processData.cpu,
      memory: processData.memory,
      uptime,
      restarts
    };
  }

  /**
   * Get metrics for all monitored processes
   */
  getAllMetrics(): Record<string, ProcessMetrics> {
    const allMetrics: Record<string, ProcessMetrics> = {};

    for (const processId of this.monitoredProcesses.keys()) {
      const metrics = this.getMetrics(processId);
      if (metrics) {
        allMetrics[processId] = metrics;
      }
    }

    return allMetrics;
  }

  /**
   * Get metrics history for a process
   */
  getMetricsHistory(processId: string): ProcessMetrics[] {
    return this.metricsHistory.get(processId) || [];
  }

  /**
   * Check if a process exceeds memory limit
   */
  checkMemoryLimit(processId: string, memoryLimit: number): boolean {
    const processData = this.monitoredProcesses.get(processId);
    if (!processData || !memoryLimit || memoryLimit <= 0) {
      return false;
    }

    return processData.memory > memoryLimit;
  }

  /**
   * Get current memory usage for a process
   */
  getCurrentMemoryUsage(processId: string): number {
    const processData = this.monitoredProcesses.get(processId);
    return processData?.memory || 0;
  }

  /**
   * Check memory limits for all monitored processes
   */
  checkAllMemoryLimits(memoryLimits: Map<string, number>): string[] {
    const violatingProcesses: string[] = [];

    for (const [processId, limit] of memoryLimits) {
      if (this.checkMemoryLimit(processId, limit)) {
        violatingProcesses.push(processId);
      }
    }

    return violatingProcesses;
  }

  /**
   * Update restart count for a process
   */
  updateRestartCount(processId: string, restartCount: number): void {
    // Store restart count in a separate map or update existing metrics
    const history = this.metricsHistory.get(processId) || [];
    if (history.length > 0) {
      const lastEntry = history[history.length - 1];
      if (lastEntry) {
        lastEntry.restarts = restartCount;
      }
    }
  }

  /**
   * Get system information
   */
  async getSystemInfo(): Promise<SystemInfo> {
    try {
      // Use Bun's built-in system information if available
      const totalMemory = this.getTotalMemory();
      const freeMemory = this.getFreeMemory();
      const cpuCount = navigator.hardwareConcurrency || 1;

      return {
        totalMemory,
        freeMemory,
        cpuCount
      };
    } catch (error) {
      // Fallback values
      return {
        totalMemory: 0,
        freeMemory: 0,
        cpuCount: 1
      };
    }
  }

  /**
   * Collect metrics for a specific process
   */
  private async collectMetrics(processId: string): Promise<void> {
    const processData = this.monitoredProcesses.get(processId);
    if (!processData) {
      return;
    }

    try {
      const { cpu, memory } = await this.getProcessResourceUsage(processData.pid);
      
      // Update current data
      processData.cpu = cpu;
      processData.memory = memory;

      // Add to history
      const uptime = Math.floor((Date.now() - processData.startTime.getTime()) / 1000);
      const restarts = this.getRestartCount(processId);

      const metrics: ProcessMetrics = {
        cpu,
        memory,
        uptime,
        restarts
      };

      const metricsHistory = this.metricsHistory.get(processId) || [];
      metricsHistory.push(metrics);

      // Limit history size
      if (metricsHistory.length > this.MAX_HISTORY_LENGTH) {
        metricsHistory.shift();
      }

      this.metricsHistory.set(processId, metricsHistory);
    } catch (error) {
      console.error(`Failed to collect metrics for process ${processId}:`, error);
    }
  }

  /**
   * Get resource usage for a specific PID
   */
  private async getProcessResourceUsage(pid: number): Promise<{ cpu: number; memory: number }> {
    try {
      // Use ps command to get process information
      const psResult = Bun.spawn({
        cmd: ['ps', '-p', pid.toString(), '-o', 'pid,pcpu,rss'],
        stdout: 'pipe'
      });

      const output = await new Response(psResult.stdout).text();
      const lines = output.trim().split('\n');
      
      if (lines.length < 2) {
        throw new Error('Process not found');
      }

      // Parse the second line (first line is header)
      const processLine = lines[1]?.trim().split(/\s+/);
      if (!processLine || processLine.length < 3) {
        throw new Error('Invalid ps output format');
      }

      const cpu = parseFloat(processLine[1] || '0') || 0;
      const memoryKB = parseInt(processLine[2] || '0') || 0;
      const memory = memoryKB * 1024; // Convert KB to bytes

      return { cpu, memory };
    } catch (error) {
      // Return zero values if we can't get metrics
      return { cpu: 0, memory: 0 };
    }
  }

  /**
   * Get total system memory
   */
  private getTotalMemory(): number {
    try {
      // Try to read from /proc/meminfo on Linux-like systems
      const proc = Bun.spawnSync({
        cmd: ['sysctl', '-n', 'hw.memsize'], // macOS
        stdout: 'pipe'
      });

      if (proc.success) {
        const output = new TextDecoder().decode(proc.stdout);
        return parseInt(output.trim()) || 0;
      }

      // Fallback: try Linux approach
      const procLinux = Bun.spawnSync({
        cmd: ['cat', '/proc/meminfo'],
        stdout: 'pipe'
      });

      if (procLinux.success) {
        const output = new TextDecoder().decode(procLinux.stdout);
        const match = output.match(/MemTotal:\s+(\d+)\s+kB/);
        if (match && match[1]) {
          return parseInt(match[1]) * 1024; // Convert KB to bytes
        }
      }

      return 0;
    } catch {
      return 0;
    }
  }

  /**
   * Get free system memory
   */
  private getFreeMemory(): number {
    try {
      // Try macOS approach
      const proc = Bun.spawnSync({
        cmd: ['vm_stat'],
        stdout: 'pipe'
      });

      if (proc.success) {
        const output = new TextDecoder().decode(proc.stdout);
        const freeMatch = output.match(/Pages free:\s+(\d+)/);
        const pageSize = 4096; // Typical page size
        
        if (freeMatch && freeMatch[1]) {
          return parseInt(freeMatch[1]) * pageSize;
        }
      }

      // Fallback: try Linux approach
      const procLinux = Bun.spawnSync({
        cmd: ['cat', '/proc/meminfo'],
        stdout: 'pipe'
      });

      if (procLinux.success) {
        const output = new TextDecoder().decode(procLinux.stdout);
        const match = output.match(/MemAvailable:\s+(\d+)\s+kB/);
        if (match && match[1]) {
          return parseInt(match[1]) * 1024; // Convert KB to bytes
        }
      }

      return 0;
    } catch {
      return 0;
    }
  }

  /**
   * Get restart count for a process (placeholder - should be provided by process manager)
   */
  private getRestartCount(_processId: string): number {
    // This should be provided by the process manager
    // For now, return 0 as a placeholder
    return 0;
  }

  /**
   * Clean up all monitoring
   */
  cleanup(): void {
    // Stop all monitoring intervals
    for (const interval of this.monitoringIntervals.values()) {
      clearInterval(interval);
    }

    // Clear all data
    this.monitoringIntervals.clear();
    this.monitoredProcesses.clear();
    this.metricsHistory.clear();
  }
}