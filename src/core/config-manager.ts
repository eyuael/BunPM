import { resolve, dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import {
  ProcessConfig,
  EcosystemConfig,
  ValidationResult,
  validateProcessConfig,
  createProcessConfig
} from "../types/index.js";

/**
 * Configuration manager for handling ecosystem files and process configurations
 */
export class ConfigManager {
  private configDir: string;

  constructor(configDir?: string) {
    this.configDir = configDir || resolve(process.env.HOME || '~', '.bun-pm');
    this.ensureConfigDir();
  }

  /**
   * Parse and validate an ecosystem configuration file
   */
  async parseEcosystemFile(filePath: string): Promise<{ config: EcosystemConfig; errors: string[] }> {
    const errors: string[] = [];

    try {
      // Check if file exists
      if (!existsSync(filePath)) {
        errors.push(`Configuration file not found: ${filePath}`);
        return { config: { apps: [], version: '1.0.0', created: new Date() }, errors };
      }

      // Read and parse the file
      const configFile = Bun.file(filePath);
      let configData: any;

      try {
        configData = await configFile.json();
      } catch (parseError) {
        errors.push(`Invalid JSON in configuration file: ${parseError instanceof Error ? parseError.message : 'Unknown parsing error'}`);
        return { config: { apps: [], version: '1.0.0', created: new Date() }, errors };
      }

      // Validate top-level structure
      const validationResult = this.validateEcosystemStructure(configData);
      if (!validationResult.isValid) {
        errors.push(...validationResult.errors);
      }

      // Ensure apps array exists
      if (!configData.apps) {
        configData.apps = [];
      }

      // Validate and process each app configuration
      const validApps: ProcessConfig[] = [];
      const configDir = dirname(resolve(filePath));

      for (let i = 0; i < configData.apps.length; i++) {
        const appConfig = configData.apps[i];
        const appErrors: string[] = [];

        try {
          // Process the app configuration
          const processedConfig = this.processAppConfig(appConfig, configDir);
          
          // Validate the processed configuration
          const validation = validateProcessConfig(processedConfig);
          if (!validation.isValid) {
            appErrors.push(...validation.errors);
          } else {
            validApps.push(processedConfig);
          }
        } catch (error) {
          appErrors.push(error instanceof Error ? error.message : 'Unknown error processing app configuration');
        }

        if (appErrors.length > 0) {
          errors.push(`App ${i + 1} (${appConfig.name || appConfig.id || 'unnamed'}): ${appErrors.join(', ')}`);
        }
      }

      const ecosystemConfig: EcosystemConfig = {
        apps: validApps,
        version: configData.version || '1.0.0',
        created: configData.created ? new Date(configData.created) : new Date()
      };

      return { config: ecosystemConfig, errors };
    } catch (error) {
      errors.push(`Failed to parse configuration file: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { config: { apps: [], version: '1.0.0', created: new Date() }, errors };
    }
  }

  /**
   * Save process configurations to an ecosystem file
   */
  async saveEcosystemFile(filePath: string, configs: ProcessConfig[]): Promise<ValidationResult> {
    const errors: string[] = [];

    try {
      // Ensure directory exists
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Create ecosystem configuration
      const ecosystemConfig: EcosystemConfig = {
        apps: configs,
        version: '1.0.0',
        created: new Date()
      };

      // Validate each configuration before saving
      for (const config of configs) {
        const validation = validateProcessConfig(config);
        if (!validation.isValid) {
          errors.push(`Invalid configuration for '${config.name}': ${validation.errors.join(', ')}`);
        }
      }

      if (errors.length > 0) {
        return { isValid: false, errors };
      }

      // Write to file with pretty formatting
      await Bun.write(filePath, JSON.stringify(ecosystemConfig, null, 2));

      return { isValid: true, errors: [] };
    } catch (error) {
      errors.push(`Failed to save configuration file: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { isValid: false, errors };
    }
  }

  /**
   * Load the default ecosystem configuration
   */
  async loadDefaultConfig(): Promise<{ config: EcosystemConfig; errors: string[] }> {
    const defaultPath = resolve(this.configDir, 'ecosystem.json');
    return this.parseEcosystemFile(defaultPath);
  }

  /**
   * Save to the default ecosystem configuration
   */
  async saveDefaultConfig(configs: ProcessConfig[]): Promise<ValidationResult> {
    const defaultPath = resolve(this.configDir, 'ecosystem.json');
    return this.saveEcosystemFile(defaultPath, configs);
  }

  /**
   * Validate ecosystem file structure
   */
  private validateEcosystemStructure(data: any): ValidationResult {
    const errors: string[] = [];

    if (typeof data !== 'object' || data === null) {
      errors.push('Configuration must be a JSON object');
      return { isValid: false, errors };
    }

    if (data.apps !== undefined) {
      if (!Array.isArray(data.apps)) {
        errors.push('apps must be an array');
      }
    }

    if (data.version !== undefined && typeof data.version !== 'string') {
      errors.push('version must be a string');
    }

    if (data.created !== undefined) {
      const createdDate = new Date(data.created);
      if (isNaN(createdDate.getTime())) {
        errors.push('created must be a valid date');
      }
    }

    return { isValid: errors.length === 0, errors };
  }

  /**
   * Process and normalize app configuration from ecosystem file
   */
  private processAppConfig(appConfig: any, configDir: string): ProcessConfig {
    // Generate ID if not provided
    const id = appConfig.id || appConfig.name || `app_${Date.now()}`;
    
    // Generate name if not provided
    const name = appConfig.name || id;

    // Resolve script path relative to config file directory
    let script = appConfig.script;
    if (!script) {
      throw new Error('script is required');
    }

    // If script is not absolute, resolve relative to config directory
    if (!script.startsWith('/')) {
      script = resolve(configDir, script);
    }

    // Resolve working directory
    let cwd = appConfig.cwd || appConfig.pwd || configDir;
    if (!cwd.startsWith('/')) {
      cwd = resolve(configDir, cwd);
    }

    // Process environment variables
    const env: Record<string, string> = {};
    
    // Add default environment variables
    if (appConfig.env) {
      if (typeof appConfig.env === 'object' && !Array.isArray(appConfig.env)) {
        for (const [key, value] of Object.entries(appConfig.env)) {
          if (typeof key === 'string' && (typeof value === 'string' || typeof value === 'number')) {
            env[key] = String(value);
          }
        }
      }
    }

    // Handle common PM2-style environment configurations
    if (appConfig.env_production) {
      Object.assign(env, appConfig.env_production);
    }
    if (appConfig.env_development) {
      Object.assign(env, appConfig.env_development);
    }

    // Process instances (support PM2-style exec_mode)
    let instances = 1;
    if (appConfig.instances !== undefined) {
      if (typeof appConfig.instances === 'number' && appConfig.instances > 0) {
        instances = Math.floor(appConfig.instances);
      } else if (appConfig.instances === 'max') {
        // Use number of CPU cores
        instances = require('os').cpus().length;
      }
    } else if (appConfig.exec_mode === 'cluster') {
      // PM2 compatibility: cluster mode defaults to CPU count
      instances = require('os').cpus().length;
    }

    // Process autorestart settings
    let autorestart = true;
    if (appConfig.autorestart !== undefined) {
      autorestart = Boolean(appConfig.autorestart);
    }
    // PM2 compatibility
    if (appConfig.restart_delay !== undefined) {
      // Note: We don't implement restart_delay, but we acknowledge it
    }

    // Process max restarts
    let maxRestarts = 10;
    if (appConfig.max_restarts !== undefined && typeof appConfig.max_restarts === 'number') {
      maxRestarts = Math.max(0, Math.floor(appConfig.max_restarts));
    }

    // Process memory limit
    let memoryLimit: number | undefined;
    if (appConfig.max_memory_restart) {
      if (typeof appConfig.max_memory_restart === 'string') {
        // Parse memory strings like "100M", "1G"
        memoryLimit = this.parseMemoryString(appConfig.max_memory_restart);
      } else if (typeof appConfig.max_memory_restart === 'number') {
        memoryLimit = appConfig.max_memory_restart;
      }
    }

    return createProcessConfig({
      id,
      name,
      script,
      cwd,
      env,
      instances,
      autorestart,
      maxRestarts,
      memoryLimit
    });
  }

  /**
   * Parse memory strings like "100M", "1G" to bytes
   */
  private parseMemoryString(memoryStr: string): number {
    const match = memoryStr.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)B?$/i);
    if (!match) {
      throw new Error(`Invalid memory format: ${memoryStr}`);
    }

    const value = parseFloat(match[1]);
    const unit = (match[2] || '').toUpperCase();

    const multipliers: Record<string, number> = {
      '': 1,
      'K': 1024,
      'M': 1024 * 1024,
      'G': 1024 * 1024 * 1024,
      'T': 1024 * 1024 * 1024 * 1024
    };

    const multiplier = multipliers[unit];
    if (multiplier === undefined) {
      throw new Error(`Invalid memory unit: ${unit}`);
    }

    return Math.floor(value * multiplier);
  }

  /**
   * Ensure configuration directory exists
   */
  private ensureConfigDir(): void {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }
  }

  /**
   * Create a sample ecosystem configuration file
   */
  async createSampleConfig(filePath: string): Promise<ValidationResult> {
    const sampleConfig: EcosystemConfig = {
      apps: [
        {
          id: 'my-app',
          name: 'my-app',
          script: './index.js',
          cwd: process.cwd(),
          env: {
            NODE_ENV: 'production',
            PORT: '3000'
          },
          instances: 1,
          autorestart: true,
          maxRestarts: 10,
          memoryLimit: 512 * 1024 * 1024 // 512MB
        }
      ],
      version: '1.0.0',
      created: new Date()
    };

    try {
      await Bun.write(filePath, JSON.stringify(sampleConfig, null, 2));
      return { isValid: true, errors: [] };
    } catch (error) {
      return {
        isValid: false,
        errors: [`Failed to create sample config: ${error instanceof Error ? error.message : 'Unknown error'}`]
      };
    }
  }
}