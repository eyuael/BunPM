import { test, expect, describe, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import {
  ProcessConfig,
  ProcessInstance,
  IPCMessage,
  IPCResponse,
  validateProcessConfig,
  createProcessConfig,
  validateProcessInstance,
  createProcessInstance,
  updateProcessStatus,
  incrementRestartCount,
  validateIPCMessage,
  validateIPCResponse,
  serializeIPCMessage,
  deserializeIPCMessage,
  serializeIPCResponse,
  deserializeIPCResponse,
  createIPCMessage,
  createSuccessResponse,
  createErrorResponse,
  ProcessStatus
} from "../src/types/index";

describe("ProcessConfig validation", () => {
  let testDir: string;
  let testScript: string;

  beforeEach(() => {
    // Create temporary test directory and script
    testDir = join(process.cwd(), "test-temp");
    testScript = join(testDir, "test-script.js");
    
    try {
      mkdirSync(testDir, { recursive: true });
      writeFileSync(testScript, "console.log('test');");
    } catch (error) {
      // Directory might already exist
    }
  });

  test("validates valid ProcessConfig", () => {
    const config = {
      id: "test-1",
      name: "test-process",
      script: "test-script.js",
      cwd: testDir,
      env: { NODE_ENV: "test" },
      instances: 2,
      autorestart: true,
      maxRestarts: 5,
      memoryLimit: 1024 * 1024 * 100 // 100MB
    };

    const result = validateProcessConfig(config);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("rejects ProcessConfig with missing required fields", () => {
    const config = {
      // Missing id, name, script, cwd
      env: {},
      instances: 1,
      autorestart: true,
      maxRestarts: 10
    };

    const result = validateProcessConfig(config);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain("id is required and must be a non-empty string");
    expect(result.errors).toContain("name is required and must be a non-empty string");
    expect(result.errors).toContain("script is required and must be a non-empty string");
    expect(result.errors).toContain("cwd is required and must be a non-empty string");
  });

  test("rejects ProcessConfig with empty string fields", () => {
    const config = {
      id: "",
      name: "  ",
      script: "",
      cwd: "",
      env: {},
      instances: 1,
      autorestart: true,
      maxRestarts: 10
    };

    const result = validateProcessConfig(config);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain("id is required and must be a non-empty string");
    expect(result.errors).toContain("name is required and must be a non-empty string");
    expect(result.errors).toContain("script is required and must be a non-empty string");
    expect(result.errors).toContain("cwd is required and must be a non-empty string");
  });

  test("rejects ProcessConfig with non-existent script file", () => {
    const config = {
      id: "test-1",
      name: "test-process",
      script: "non-existent-script.js",
      cwd: testDir,
      env: {},
      instances: 1,
      autorestart: true,
      maxRestarts: 10
    };

    const result = validateProcessConfig(config);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(error => error.includes("script file does not exist"))).toBe(true);
  });

  test("rejects ProcessConfig with non-existent working directory", () => {
    const config = {
      id: "test-1",
      name: "test-process",
      script: "test-script.js",
      cwd: "/non/existent/directory",
      env: {},
      instances: 1,
      autorestart: true,
      maxRestarts: 10
    };

    const result = validateProcessConfig(config);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(error => error.includes("working directory does not exist"))).toBe(true);
  });

  test("rejects ProcessConfig with invalid env object", () => {
    const config = {
      id: "test-1",
      name: "test-process",
      script: "test-script.js",
      cwd: testDir,
      env: "not an object",
      instances: 1,
      autorestart: true,
      maxRestarts: 10
    };

    const result = validateProcessConfig(config);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain("env must be an object");
  });

  test("rejects ProcessConfig with invalid instances", () => {
    const config = {
      id: "test-1",
      name: "test-process",
      script: "test-script.js",
      cwd: testDir,
      env: {},
      instances: 0,
      autorestart: true,
      maxRestarts: 10
    };

    const result = validateProcessConfig(config);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain("instances must be a positive integer");
  });

  test("rejects ProcessConfig with invalid maxRestarts", () => {
    const config = {
      id: "test-1",
      name: "test-process",
      script: "test-script.js",
      cwd: testDir,
      env: {},
      instances: 1,
      autorestart: true,
      maxRestarts: -1
    };

    const result = validateProcessConfig(config);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain("maxRestarts must be a non-negative integer");
  });

  test("rejects ProcessConfig with invalid memoryLimit", () => {
    const config = {
      id: "test-1",
      name: "test-process",
      script: "test-script.js",
      cwd: testDir,
      env: {},
      instances: 1,
      autorestart: true,
      maxRestarts: 10,
      memoryLimit: -100
    };

    const result = validateProcessConfig(config);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain("memoryLimit must be a positive integer (bytes)");
  });
});

describe("ProcessConfig creation", () => {
  test("creates ProcessConfig with defaults", () => {
    const config = createProcessConfig({
      id: "test-1",
      name: "test-process",
      script: "test.js"
    });

    expect(config.id).toBe("test-1");
    expect(config.name).toBe("test-process");
    expect(config.script).toBe("test.js");
    expect(config.cwd).toBe(process.cwd());
    expect(config.env).toEqual({});
    expect(config.instances).toBe(1);
    expect(config.autorestart).toBe(true);
    expect(config.maxRestarts).toBe(10);
  });

  test("creates ProcessConfig with custom values", () => {
    const config = createProcessConfig({
      id: "test-1",
      name: "test-process",
      script: "test.js",
      cwd: "/custom/path",
      env: { NODE_ENV: "production" },
      instances: 4,
      autorestart: false,
      maxRestarts: 5,
      memoryLimit: 1024 * 1024 * 512
    });

    expect(config.cwd).toBe("/custom/path");
    expect(config.env).toEqual({ NODE_ENV: "production" });
    expect(config.instances).toBe(4);
    expect(config.autorestart).toBe(false);
    expect(config.maxRestarts).toBe(5);
    expect(config.memoryLimit).toBe(1024 * 1024 * 512);
  });
});

describe("ProcessInstance validation", () => {
  test("validates valid ProcessInstance", () => {
    const instance = {
      id: "test-1",
      pid: 12345,
      status: "running" as ProcessStatus,
      startTime: new Date(),
      restartCount: 0,
      subprocess: {} as any // Mock subprocess
    };

    const result = validateProcessInstance(instance);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("rejects ProcessInstance with invalid id", () => {
    const instance = {
      id: 123, // Should be string
      pid: 12345,
      status: "running" as ProcessStatus,
      startTime: new Date(),
      restartCount: 0,
      subprocess: {} as any
    };

    const result = validateProcessInstance(instance);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain("id is required and must be a string");
  });

  test("rejects ProcessInstance with invalid pid", () => {
    const instance = {
      id: "test-1",
      pid: -1, // Should be positive
      status: "running" as ProcessStatus,
      startTime: new Date(),
      restartCount: 0,
      subprocess: {} as any
    };

    const result = validateProcessInstance(instance);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain("pid must be a positive integer");
  });

  test("rejects ProcessInstance with invalid status", () => {
    const instance = {
      id: "test-1",
      pid: 12345,
      status: "invalid-status" as any,
      startTime: new Date(),
      restartCount: 0,
      subprocess: {} as any
    };

    const result = validateProcessInstance(instance);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain("status must be one of: running, stopped, errored, restarting");
  });

  test("rejects ProcessInstance with invalid startTime", () => {
    const instance = {
      id: "test-1",
      pid: 12345,
      status: "running" as ProcessStatus,
      startTime: "not a date" as any,
      restartCount: 0,
      subprocess: {} as any
    };

    const result = validateProcessInstance(instance);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain("startTime must be a valid Date object");
  });

  test("rejects ProcessInstance with invalid restartCount", () => {
    const instance = {
      id: "test-1",
      pid: 12345,
      status: "running" as ProcessStatus,
      startTime: new Date(),
      restartCount: -1, // Should be non-negative
      subprocess: {} as any
    };

    const result = validateProcessInstance(instance);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain("restartCount must be a non-negative integer");
  });
});

describe("ProcessInstance management", () => {
  test("creates ProcessInstance with defaults", () => {
    const mockSubprocess = {} as any;
    const instance = createProcessInstance("test-1", 12345, mockSubprocess);

    expect(instance.id).toBe("test-1");
    expect(instance.pid).toBe(12345);
    expect(instance.status).toBe("running");
    expect(instance.startTime).toBeInstanceOf(Date);
    expect(instance.restartCount).toBe(0);
    expect(instance.subprocess).toBe(mockSubprocess);
  });

  test("creates ProcessInstance with custom status", () => {
    const mockSubprocess = {} as any;
    const instance = createProcessInstance("test-1", 12345, mockSubprocess, "stopped");

    expect(instance.status).toBe("stopped");
  });

  test("updates ProcessInstance status", () => {
    const mockSubprocess = {} as any;
    const instance = createProcessInstance("test-1", 12345, mockSubprocess);
    const updatedInstance = updateProcessStatus(instance, "errored");

    expect(updatedInstance.status).toBe("errored");
    expect(updatedInstance.id).toBe(instance.id);
    expect(updatedInstance.pid).toBe(instance.pid);
  });

  test("increments restart count", () => {
    const mockSubprocess = {} as any;
    const instance = createProcessInstance("test-1", 12345, mockSubprocess);
    const updatedInstance = incrementRestartCount(instance);

    expect(updatedInstance.restartCount).toBe(1);
    expect(updatedInstance.id).toBe(instance.id);
    expect(updatedInstance.pid).toBe(instance.pid);
  });
});

describe("IPCMessage validation", () => {
  test("validates valid IPCMessage", () => {
    const message = {
      id: "msg-1",
      command: "start",
      payload: { script: "test.js" }
    };

    const result = validateIPCMessage(message);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("rejects IPCMessage with missing id", () => {
    const message = {
      command: "start",
      payload: {}
    };

    const result = validateIPCMessage(message);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain("id is required and must be a string");
  });

  test("rejects IPCMessage with missing command", () => {
    const message = {
      id: "msg-1",
      payload: {}
    };

    const result = validateIPCMessage(message);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain("command is required and must be a string");
  });

  test("accepts IPCMessage with any payload type", () => {
    const messages = [
      { id: "msg-1", command: "start", payload: null },
      { id: "msg-2", command: "start", payload: undefined },
      { id: "msg-3", command: "start", payload: "string" },
      { id: "msg-4", command: "start", payload: 123 },
      { id: "msg-5", command: "start", payload: { key: "value" } },
      { id: "msg-6", command: "start", payload: [1, 2, 3] }
    ];

    messages.forEach(message => {
      const result = validateIPCMessage(message);
      expect(result.isValid).toBe(true);
    });
  });
});

describe("IPCResponse validation", () => {
  test("validates valid IPCResponse", () => {
    const response = {
      id: "msg-1",
      success: true,
      data: { result: "ok" }
    };

    const result = validateIPCResponse(response);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("validates valid error IPCResponse", () => {
    const response = {
      id: "msg-1",
      success: false,
      error: "Something went wrong"
    };

    const result = validateIPCResponse(response);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("rejects IPCResponse with missing id", () => {
    const response = {
      success: true,
      data: {}
    };

    const result = validateIPCResponse(response);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain("id is required and must be a string");
  });

  test("rejects IPCResponse with missing success", () => {
    const response = {
      id: "msg-1",
      data: {}
    };

    const result = validateIPCResponse(response);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain("success is required and must be a boolean");
  });

  test("rejects IPCResponse with invalid error type", () => {
    const response = {
      id: "msg-1",
      success: false,
      error: 123 // Should be string
    };

    const result = validateIPCResponse(response);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain("error must be a string if provided");
  });
});

describe("IPC serialization", () => {
  test("serializes and deserializes IPCMessage", () => {
    const message: IPCMessage = {
      id: "msg-1",
      command: "start",
      payload: { script: "test.js", instances: 2 }
    };

    const serialized = serializeIPCMessage(message);
    expect(typeof serialized).toBe("string");

    const deserialized = deserializeIPCMessage(serialized);
    expect(deserialized).toEqual(message);
  });

  test("serializes and deserializes IPCResponse", () => {
    const response: IPCResponse = {
      id: "msg-1",
      success: true,
      data: { processId: "test-1", pid: 12345 }
    };

    const serialized = serializeIPCResponse(response);
    expect(typeof serialized).toBe("string");

    const deserialized = deserializeIPCResponse(serialized);
    expect(deserialized).toEqual(response);
  });

  test("handles serialization errors", () => {
    const circularObj: any = {};
    circularObj.self = circularObj;

    const message: IPCMessage = {
      id: "msg-1",
      command: "start",
      payload: circularObj
    };

    expect(() => serializeIPCMessage(message)).toThrow("Failed to serialize IPC message");
  });

  test("handles deserialization of invalid JSON", () => {
    const invalidJson = "{ invalid json }";

    expect(() => deserializeIPCMessage(invalidJson)).toThrow("Invalid JSON in IPC message");
  });

  test("handles deserialization of invalid IPCMessage structure", () => {
    const invalidMessage = JSON.stringify({ command: "start" }); // Missing id

    expect(() => deserializeIPCMessage(invalidMessage)).toThrow("Invalid IPC message");
  });

  test("handles deserialization of invalid IPCResponse structure", () => {
    const invalidResponse = JSON.stringify({ id: "msg-1" }); // Missing success

    expect(() => deserializeIPCResponse(invalidResponse)).toThrow("Invalid IPC response");
  });
});

describe("IPC helper functions", () => {
  test("creates IPCMessage with generated ID", () => {
    const message = createIPCMessage("start", { script: "test.js" });

    expect(message.command).toBe("start");
    expect(message.payload).toEqual({ script: "test.js" });
    expect(typeof message.id).toBe("string");
    expect(message.id.length).toBeGreaterThan(0);
  });

  test("creates IPCMessage with empty payload", () => {
    const message = createIPCMessage("list");

    expect(message.command).toBe("list");
    expect(message.payload).toEqual({});
    expect(typeof message.id).toBe("string");
  });

  test("creates success IPCResponse", () => {
    const response = createSuccessResponse("msg-1", { result: "ok" });

    expect(response.id).toBe("msg-1");
    expect(response.success).toBe(true);
    expect(response.data).toEqual({ result: "ok" });
    expect(response.error).toBeUndefined();
  });

  test("creates success IPCResponse without data", () => {
    const response = createSuccessResponse("msg-1");

    expect(response.id).toBe("msg-1");
    expect(response.success).toBe(true);
    expect(response.data).toBeUndefined();
  });

  test("creates error IPCResponse", () => {
    const response = createErrorResponse("msg-1", "Something went wrong");

    expect(response.id).toBe("msg-1");
    expect(response.success).toBe(false);
    expect(response.error).toBe("Something went wrong");
    expect(response.data).toBeUndefined();
  });
});

// Cleanup after tests
test("cleanup test files", () => {
  try {
    rmSync(join(process.cwd(), "test-temp"), { recursive: true, force: true });
  } catch (error) {
    // Ignore cleanup errors
  }
});