import { test, expect, beforeEach, afterEach } from "bun:test";
import { ConfigManager } from "../src/core/config-manager.js";
import { ProcessConfig, EcosystemConfig } from "../src/types/index.js";
import { resolve, dirname } from "path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";

let configManager: ConfigManager;
let testDir: string;
let testConfigPath: string;

beforeEach(() => {
  // Create temporary directory for tests
  testDir = resolve(tmpdir(), `bun-pm-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  
  configManager = new ConfigManager(testDir);
  testConfigPath = resolve(testDir, 'test-ecosystem.json');
});

afterEach(() => {
  // Clean up test directory
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("should parse valid ecosystem file", async () => {
    const ecosystemConfig = {
      apps: [
        {
          id: "test-app",
          name: "test-app",
          script: "./test.js",
          cwd: testDir,
          env: {
            NODE_ENV: "production",
            PORT: "3000"
          },
          instances: 2,
          autorestart: true,
          max_restarts: 5
        }
      ],
      version: "1.0.0",
      created: new Date().toISOString()
    };

    writeFileSync(testConfigPath, JSON.stringify(ecosystemConfig, null, 2));

    // Create test script file
    const testScriptPath = resolve(testDir, 'test.js');
    writeFileSync(testScriptPath, 'console.log("Hello World");');

    const { config, errors } = await configManager.parseEcosystemFile(testConfigPath);

    expect(errors).toHaveLength(0);
    expect(config.apps).toHaveLength(1);
    
    const app = config.apps[0];
    expect(app.id).toBe("test-app");
    expect(app.name).toBe("test-app");
    expect(app.script).toBe(testScriptPath); // Should be resolved to absolute path
    expect(app.cwd).toBe(testDir);
    expect(app.env.NODE_ENV).toBe("production");
    expect(app.env.PORT).toBe("3000");
    expect(app.instances).toBe(2);
    expect(app.autorestart).toBe(true);
    expect(app.maxRestarts).toBe(5);
});

test("should handle PM2-style configuration", async () => {
    const pm2Config = {
      apps: [
        {
          name: "web-app",
          script: "./server.js",
          exec_mode: "cluster",
          instances: "max",
          env_production: {
            NODE_ENV: "production",
            PORT: "8000"
          },
          max_memory_restart: "500M",
          restart_delay: 4000
        }
      ]
    };

    writeFileSync(testConfigPath, JSON.stringify(pm2Config, null, 2));

    // Create test script file
    const testScriptPath = resolve(testDir, 'server.js');
    writeFileSync(testScriptPath, 'console.log("Server starting");');

    const { config, errors } = await configManager.parseEcosystemFile(testConfigPath);

    expect(errors).toHaveLength(0);
    expect(config.apps).toHaveLength(1);
    
    const app = config.apps[0];
    expect(app.name).toBe("web-app");
    expect(app.instances).toBeGreaterThan(1); // Should use CPU count
    expect(app.env.NODE_ENV).toBe("production");
    expect(app.env.PORT).toBe("8000");
    expect(app.memoryLimit).toBe(500 * 1024 * 1024); // 500MB in bytes
});

test("should validate and report errors for invalid configuration", async () => {
    const invalidConfig = {
      apps: [
        {
          // Missing required fields
          name: "invalid-app",
          // script is missing
          instances: -1, // Invalid instances
          env: "not-an-object", // Invalid env
          max_restarts: "not-a-number" // Invalid max_restarts
        }
      ]
    };

    writeFileSync(testConfigPath, JSON.stringify(invalidConfig, null, 2));

    const { config, errors } = await configManager.parseEcosystemFile(testConfigPath);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(error => error.includes('script is required'))).toBe(true);
});

test("should handle missing script file", async () => {
    const configWithMissingScript = {
      apps: [
        {
          id: "missing-script-app",
          name: "missing-script-app",
          script: "./nonexistent.js"
        }
      ]
    };

    writeFileSync(testConfigPath, JSON.stringify(configWithMissingScript, null, 2));

    const { config, errors } = await configManager.parseEcosystemFile(testConfigPath);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(error => error.includes('script file does not exist'))).toBe(true);
});

test("should handle invalid JSON file", async () => {
    writeFileSync(testConfigPath, '{ invalid json }');

    const { config, errors } = await configManager.parseEcosystemFile(testConfigPath);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(error => error.includes('Invalid JSON'))).toBe(true);
    expect(config.apps).toHaveLength(0);
});

test("should handle missing file", async () => {
    const nonexistentPath = resolve(testDir, 'nonexistent.json');

    const { config, errors } = await configManager.parseEcosystemFile(nonexistentPath);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(error => error.includes('Configuration file not found'))).toBe(true);
    expect(config.apps).toHaveLength(0);
});

test("should save ecosystem file", async () => {
    // Create the script files that will be referenced
    const app1Script = resolve(testDir, 'app1.js');
    const app2Script = resolve(testDir, 'app2.js');
    writeFileSync(app1Script, 'console.log("App1");');
    writeFileSync(app2Script, 'console.log("App2");');

    const configs: ProcessConfig[] = [
      {
        id: "app1",
        name: "app1",
        script: app1Script,
        cwd: testDir,
        env: { NODE_ENV: "production" },
        instances: 1,
        autorestart: true,
        maxRestarts: 10
      },
      {
        id: "app2",
        name: "app2",
        script: app2Script,
        cwd: testDir,
        env: { NODE_ENV: "development", PORT: "3001" },
        instances: 2,
        autorestart: false,
        maxRestarts: 5,
        memoryLimit: 256 * 1024 * 1024
      }
    ];

    const result = await configManager.saveEcosystemFile(testConfigPath, configs);

    if (!result.isValid) {
      console.log('Validation errors:', result.errors);
    }
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(existsSync(testConfigPath)).toBe(true);

    // Verify saved content
    const savedContent = JSON.parse(await Bun.file(testConfigPath).text());
    expect(savedContent.apps).toHaveLength(2);
    expect(savedContent.apps[0].id).toBe("app1");
    expect(savedContent.apps[1].id).toBe("app2");
    expect(savedContent.version).toBe("1.0.0");
    expect(savedContent.created).toBeDefined();
});

test("should parse memory strings correctly", async () => {
    const configWithMemory = {
      apps: [
        {
          id: "memory-test",
          name: "memory-test",
          script: "./test.js",
          max_memory_restart: "1G"
        }
      ]
    };

    writeFileSync(testConfigPath, JSON.stringify(configWithMemory, null, 2));

    // Create test script file
    const testScriptPath = resolve(testDir, 'test.js');
    writeFileSync(testScriptPath, 'console.log("Test");');

    const { config, errors } = await configManager.parseEcosystemFile(testConfigPath);

    expect(errors).toHaveLength(0);
    expect(config.apps[0].memoryLimit).toBe(1024 * 1024 * 1024); // 1GB in bytes
});

test("should handle relative paths correctly", async () => {
    // Create subdirectory
    const subDir = resolve(testDir, 'subdir');
    mkdirSync(subDir);
    
    const subConfigPath = resolve(subDir, 'ecosystem.json');
    
    const configWithRelativePaths = {
      apps: [
        {
          id: "relative-app",
          name: "relative-app",
          script: "../test.js", // Relative to config file
          cwd: ".." // Relative to config file
        }
      ]
    };

    writeFileSync(subConfigPath, JSON.stringify(configWithRelativePaths, null, 2));

    // Create test script file in parent directory
    const testScriptPath = resolve(testDir, 'test.js');
    writeFileSync(testScriptPath, 'console.log("Test");');

    const { config, errors } = await configManager.parseEcosystemFile(subConfigPath);

    expect(errors).toHaveLength(0);
    expect(config.apps[0].script).toBe(testScriptPath);
    expect(config.apps[0].cwd).toBe(testDir);
});

test("should generate IDs and names when missing", async () => {
    const configWithoutIds = {
      apps: [
        {
          script: "./test1.js"
        },
        {
          name: "named-app",
          script: "./test2.js"
        }
      ]
    };

    writeFileSync(testConfigPath, JSON.stringify(configWithoutIds, null, 2));

    // Create test script files
    writeFileSync(resolve(testDir, 'test1.js'), 'console.log("Test1");');
    writeFileSync(resolve(testDir, 'test2.js'), 'console.log("Test2");');

    const { config, errors } = await configManager.parseEcosystemFile(testConfigPath);

    expect(errors).toHaveLength(0);
    expect(config.apps).toHaveLength(2);
    
    // First app should get generated ID and name
    expect(config.apps[0].id).toBeDefined();
    expect(config.apps[0].name).toBeDefined();
    
    // Second app should use provided name and generate ID
    expect(config.apps[1].name).toBe("named-app");
    expect(config.apps[1].id).toBe("named-app");
});

test("should create sample configuration", async () => {
    const samplePath = resolve(testDir, 'sample.json');
    
    const result = await configManager.createSampleConfig(samplePath);

    expect(result.isValid).toBe(true);
    expect(existsSync(samplePath)).toBe(true);

    // Verify sample content
    const sampleContent = JSON.parse(await Bun.file(samplePath).text());
    expect(sampleContent.apps).toHaveLength(1);
    expect(sampleContent.apps[0].id).toBe("my-app");
    expect(sampleContent.apps[0].name).toBe("my-app");
    expect(sampleContent.apps[0].script).toBe("./index.js");
});

test("should handle default configuration operations", async () => {
    // Create the script file
    const appScript = resolve(testDir, 'app.js');
    writeFileSync(appScript, 'console.log("Default app");');

    const configs: ProcessConfig[] = [
      {
        id: "default-app",
        name: "default-app",
        script: appScript,
        cwd: testDir,
        env: {},
        instances: 1,
        autorestart: true,
        maxRestarts: 10
      }
    ];

    // Save to default location
    const saveResult = await configManager.saveDefaultConfig(configs);
    if (!saveResult.isValid) {
      console.log('Default save validation errors:', saveResult.errors);
    }
    expect(saveResult.isValid).toBe(true);

    // Load from default location
    const { config, errors } = await configManager.loadDefaultConfig();
    expect(errors).toHaveLength(0);
    expect(config.apps).toHaveLength(1);
    expect(config.apps[0].id).toBe("default-app");
});