/**
 * Memory optimization utilities for the Bun Process Manager
 */

/**
 * Optimized circular buffer for storing metrics history
 * Uses a fixed-size array to prevent memory growth
 */
export class CircularBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private size = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size++;
    }
  }

  toArray(): T[] {
    const result: T[] = [];
    if (this.size === 0) return result;

    const start = this.size < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.size; i++) {
      const index = (start + i) % this.capacity;
      const item = this.buffer[index];
      if (item !== undefined) {
        result.push(item);
      }
    }
    return result;
  }

  clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this.size = 0;
  }

  getSize(): number {
    return this.size;
  }

  getCapacity(): number {
    return this.capacity;
  }
}

/**
 * Memory-efficient string pool for reusing common strings
 */
export class StringPool {
  private pool = new Map<string, string>();
  private maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  intern(str: string): string {
    const existing = this.pool.get(str);
    if (existing) {
      return existing;
    }

    // If pool is full, clear it (simple eviction strategy)
    if (this.pool.size >= this.maxSize) {
      this.pool.clear();
    }

    this.pool.set(str, str);
    return str;
  }

  clear(): void {
    this.pool.clear();
  }

  getSize(): number {
    return this.pool.size;
  }
}

/**
 * Optimized log entry with memory-efficient storage
 */
export interface OptimizedLogEntry {
  timestamp: number; // Use number instead of Date for memory efficiency
  processId: string;
  stream: 'stdout' | 'stderr';
  message: string;
}

/**
 * Memory usage tracker for monitoring daemon performance
 */
export class MemoryTracker {
  private measurements: CircularBuffer<{
    timestamp: number;
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
  }>;

  constructor(historySize: number = 100) {
    this.measurements = new CircularBuffer(historySize);
  }

  recordMeasurement(): void {
    const usage = process.memoryUsage();
    this.measurements.push({
      timestamp: Date.now(),
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      rss: usage.rss,
      external: usage.external
    });
  }

  getMemoryStats() {
    const measurements = this.measurements.toArray();
    if (measurements.length === 0) {
      return null;
    }

    const latest = measurements[measurements.length - 1];
    const oldest = measurements[0];
    
    return {
      current: {
        heapUsed: latest.heapUsed,
        heapTotal: latest.heapTotal,
        rss: latest.rss,
        external: latest.external
      },
      trend: measurements.length > 1 ? {
        heapUsedDelta: latest.heapUsed - oldest.heapUsed,
        rssDelta: latest.rss - oldest.rss,
        timespan: latest.timestamp - oldest.timestamp
      } : null,
      measurements: measurements.length
    };
  }

  clear(): void {
    this.measurements.clear();
  }
}

/**
 * Optimized process configuration storage with memory pooling
 */
export class OptimizedProcessConfigStore {
  private configs = new Map<string, any>();
  private stringPool = new StringPool();

  set(id: string, config: any): void {
    // Intern common strings to reduce memory usage
    const optimizedConfig = {
      ...config,
      id: this.stringPool.intern(config.id),
      name: this.stringPool.intern(config.name),
      script: this.stringPool.intern(config.script),
      cwd: this.stringPool.intern(config.cwd)
    };

    this.configs.set(id, optimizedConfig);
  }

  get(id: string): any {
    return this.configs.get(id);
  }

  delete(id: string): boolean {
    return this.configs.delete(id);
  }

  has(id: string): boolean {
    return this.configs.has(id);
  }

  values(): IterableIterator<any> {
    return this.configs.values();
  }

  keys(): IterableIterator<string> {
    return this.configs.keys();
  }

  clear(): void {
    this.configs.clear();
    this.stringPool.clear();
  }

  getMemoryStats() {
    return {
      configCount: this.configs.size,
      stringPoolSize: this.stringPool.getSize()
    };
  }
}

/**
 * Garbage collection utilities
 */
export class GCOptimizer {
  private gcInterval: Timer | null = null;
  private memoryTracker: MemoryTracker;

  constructor(memoryTracker: MemoryTracker) {
    this.memoryTracker = memoryTracker;
  }

  startPeriodicGC(intervalMs: number = 30000): void {
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
    }

    this.gcInterval = setInterval(() => {
      this.performOptimizedGC();
    }, intervalMs);
  }

  stopPeriodicGC(): void {
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = null;
    }
  }

  performOptimizedGC(): void {
    // Record memory before GC
    this.memoryTracker.recordMeasurement();
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }
    
    // Record memory after GC
    setTimeout(() => {
      this.memoryTracker.recordMeasurement();
    }, 100);
  }
}