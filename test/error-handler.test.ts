import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  ErrorHandler,
  ProcessManagerError,
  ProcessError,
  ProcessStartupError,
  ProcessCrashError,
  ProcessRestartLimitError,
  ProcessMemoryLimitError,
  ConfigurationError,
  InvalidConfigurationError,
  ConfigurationFileNotFoundError,
  IPCError,
  IPCConnectionError,
  IPCTimeoutError,
  FileSystemError,
  FileNotFoundError,
  PermissionDeniedError,
  ResourceError,
  ResourceExhaustionError,
  ProcessRestartRecovery,
  IPCReconnectionRecovery,
  createUserFriendlyError
} from "../src/core/error-handler.js";

describe("Error Handler", () => {
  let errorHandler: ErrorHandler;

  beforeEach(() => {
    errorHandler = new ErrorHandler();
  });

  afterEach(() => {
    errorHandler.clearErrorHistory();
  });

  describe("ProcessManagerError Base Class", () => {
    test("should create error with all properties", () => {
      const error = new ProcessError(
        "Test error message",
        "TEST_ERROR",
        'error',
        true,
        { processId: "test-process" }
      );

      expect(error.message).toBe("Test error message");
      expect(error.code).toBe("TEST_ERROR");
      expect(error.category).toBe("process");
      expect(error.severity).toBe("error");
      expect(error.recoverable).toBe(true);
      expect(error.context?.processId).toBe("test-process");
      expect(error.timestamp).toBeInstanceOf(Date);
    });

    test("should provide detailed error information", () => {
      const error = new ProcessError("Test error", "TEST_ERROR");
      const details = error.getDetailedInfo();

      expect(details.name).toBe("ProcessError");
      expect(details.message).toBe("Test error");
      expect(details.code).toBe("TEST_ERROR");
      expect(details.category).toBe("process");
      expect(details.severity).toBe("error");
      expect(details.recoverable).toBe(true);
      expect(details.timestamp).toBeInstanceOf(Date);
    });
  });

  describe("Specific Error Types", () => {
    test("ProcessStartupError should format user message correctly", () => {
      const error = new ProcessStartupError("test-app", "Script not found");
      expect(error.getUserMessage()).toBe("Unable to start process 'test-app'. Script not found");
      expect(error.code).toBe("PROCESS_STARTUP_FAILED");
      expect(error.recoverable).toBe(true);
    });

    test("ProcessCrashError should include exit code information", () => {
      const error = new ProcessCrashError("test-app", 1, "SIGTERM");
      expect(error.message).toContain("exit code 1");
      expect(error.message).toContain("signal: SIGTERM");
      expect(error.getUserMessage()).toContain("stopped unexpectedly");
      expect(error.code).toBe("PROCESS_CRASHED");
    });

    test("ProcessRestartLimitError should indicate non-recoverable", () => {
      const error = new ProcessRestartLimitError("test-app", 5);
      expect(error.recoverable).toBe(false);
      expect(error.getUserMessage()).toContain("failed too many times");
      expect(error.code).toBe("PROCESS_RESTART_LIMIT_EXCEEDED");
    });

    test("ProcessMemoryLimitError should format memory values", () => {
      const error = new ProcessMemoryLimitError("test-app", 1073741824, 536870912); // 1GB current, 512MB limit
      const userMessage = error.getUserMessage();
      expect(userMessage).toContain("1024MB > 512MB");
      expect(error.code).toBe("PROCESS_MEMORY_LIMIT_EXCEEDED");
      expect(error.recoverable).toBe(true);
    });

    test("InvalidConfigurationError should list validation errors", () => {
      const errors = ["Missing script field", "Invalid instances count"];
      const error = new InvalidConfigurationError(errors);
      const userMessage = error.getUserMessage();
      expect(userMessage).toContain("2 errors");
      expect(userMessage).toContain("Missing script field");
      expect(userMessage).toContain("Invalid instances count");
    });

    test("IPCConnectionError should provide helpful message", () => {
      const error = new IPCConnectionError("/tmp/test.sock", "Connection refused");
      expect(error.getUserMessage()).toContain("Unable to connect to the process daemon");
      expect(error.recoverable).toBe(true);
    });

    test("FileNotFoundError should indicate file path issue", () => {
      const error = new FileNotFoundError("/path/to/missing/file.js");
      expect(error.getUserMessage()).toContain("does not exist");
      expect(error.recoverable).toBe(false);
    });
  });

  describe("Error Handler Functionality", () => {
    test("should log errors and maintain history", async () => {
      const error = new ProcessError("Test error", "TEST_ERROR");
      
      await errorHandler.handleError(error);
      
      const history = errorHandler.getErrorHistory();
      expect(history).toHaveLength(1);
      expect(history[0].message).toBe("Test error");
      expect(history[0].code).toBe("TEST_ERROR");
    });

    test("should convert regular errors to ProcessManagerError", async () => {
      const regularError = new Error("ENOENT: file not found");
      
      const result = await errorHandler.handleError(regularError);
      
      expect(result.handled).toBe(true);
      expect(result.message).toContain("does not exist");
      
      const history = errorHandler.getErrorHistory();
      expect(history).toHaveLength(1);
      expect(history[0].category).toBe("filesystem");
    });

    test("should maintain error statistics", async () => {
      // Add various types of errors
      await errorHandler.handleError(new ProcessError("Error 1", "TEST_1"));
      await errorHandler.handleError(new ProcessError("Error 2", "TEST_2", 'warning'));
      await errorHandler.handleError(new ConfigurationError("Config error", "CONFIG_1"));
      
      const stats = errorHandler.getErrorStats();
      
      expect(stats.total).toBe(3);
      expect(stats.byCategory.process).toBe(2);
      expect(stats.byCategory.config).toBe(1);
      expect(stats.bySeverity.error).toBe(2);
      expect(stats.bySeverity.warning).toBe(1);
    });

    test("should limit error history size", async () => {
      // Create handler with small max size for testing
      const smallHandler = new ErrorHandler();
      
      // Add more errors than the default limit
      for (let i = 0; i < 1100; i++) {
        await smallHandler.handleError(new ProcessError(`Error ${i}`, `TEST_${i}`));
      }
      
      const history = smallHandler.getErrorHistory();
      expect(history.length).toBeLessThanOrEqual(1000);
    });
  });

  describe("Recovery Strategies", () => {
    test("ProcessRestartRecovery should handle crash errors", () => {
      const recovery = new ProcessRestartRecovery();
      const crashError = new ProcessCrashError("test-app", 1);
      
      expect(recovery.canRecover(crashError)).toBe(true);
      
      const memoryError = new ProcessMemoryLimitError("test-app", 1000, 500);
      expect(recovery.canRecover(memoryError)).toBe(true);
      
      const configError = new ConfigurationError("Invalid config", "CONFIG_ERROR");
      expect(recovery.canRecover(configError)).toBe(false);
    });

    test("ProcessRestartRecovery should check restart limits", async () => {
      const recovery = new ProcessRestartRecovery();
      const error = new ProcessCrashError("test-app", 1);
      
      // Mock process manager with restart stats
      const mockProcessManager = {
        getRestartStats: () => ({ canRestart: false, restartCount: 5, maxRestarts: 5 })
      };
      
      const result = await recovery.recover(error, mockProcessManager);
      
      expect(result.success).toBe(false);
      expect(result.message).toContain("cannot be restarted");
      expect(result.retryable).toBe(false);
    });

    test("IPCReconnectionRecovery should handle IPC errors", () => {
      const recovery = new IPCReconnectionRecovery();
      const connectionError = new IPCConnectionError("/tmp/test.sock");
      const timeoutError = new IPCTimeoutError("test-command", 5000);
      
      expect(recovery.canRecover(connectionError)).toBe(true);
      expect(recovery.canRecover(timeoutError)).toBe(true);
      
      const processError = new ProcessError("Process error", "PROCESS_ERROR");
      expect(recovery.canRecover(processError)).toBe(false);
    });

    test("should attempt recovery for recoverable errors", async () => {
      const recoverableError = new ProcessCrashError("test-app", 1);
      
      // Mock process manager that allows restart
      const mockProcessManager = {
        getRestartStats: () => ({ canRestart: true, restartCount: 1, maxRestarts: 5 })
      };
      
      const result = await errorHandler.handleError(recoverableError, mockProcessManager);
      
      expect(result.handled).toBe(true);
      expect(result.recovered).toBe(true);
      expect(result.message).toContain("will be restarted automatically");
    });

    test("should not attempt recovery for non-recoverable errors", async () => {
      const nonRecoverableError = new ProcessRestartLimitError("test-app", 5);
      
      const result = await errorHandler.handleError(nonRecoverableError);
      
      expect(result.handled).toBe(true);
      expect(result.recovered).toBe(false);
    });
  });

  describe("User-Friendly Error Messages", () => {
    test("should create user-friendly messages for common Node.js errors", () => {
      const enoentError = new Error("ENOENT: no such file or directory");
      const message = createUserFriendlyError(enoentError);
      expect(message).toContain("File or directory not found");

      const eaccesError = new Error("EACCES: permission denied");
      const accessMessage = createUserFriendlyError(eaccesError);
      expect(accessMessage).toContain("Permission denied");

      const eaddrInUseError = new Error("EADDRINUSE: address already in use");
      const addrMessage = createUserFriendlyError(eaddrInUseError);
      expect(addrMessage).toContain("Address already in use");
    });

    test("should use ProcessManagerError user messages", () => {
      const processError = new ProcessStartupError("test-app", "Script not found");
      const message = createUserFriendlyError(processError);
      expect(message).toBe(processError.getUserMessage());
    });

    test("should fallback to original message for unknown errors", () => {
      const unknownError = new Error("Some unknown error");
      const message = createUserFriendlyError(unknownError);
      expect(message).toBe("Some unknown error");
    });
  });

  describe("Error Context and Details", () => {
    test("should preserve error context through handling", async () => {
      const error = new ProcessStartupError("test-app", "Failed to spawn", {
        script: "/path/to/script.js",
        cwd: "/working/dir",
        pid: 12345
      });
      
      await errorHandler.handleError(error);
      
      const history = errorHandler.getErrorHistory();
      expect(history[0].context?.script).toBe("/path/to/script.js");
      expect(history[0].context?.cwd).toBe("/working/dir");
      expect(history[0].context?.pid).toBe(12345);
    });

    test("should track error timestamps correctly", async () => {
      const beforeTime = new Date();
      await errorHandler.handleError(new ProcessError("Test", "TEST"));
      const afterTime = new Date();
      
      const history = errorHandler.getErrorHistory();
      const errorTime = new Date(history[0].timestamp);
      
      expect(errorTime.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
      expect(errorTime.getTime()).toBeLessThanOrEqual(afterTime.getTime());
    });
  });

  describe("Error Statistics and Filtering", () => {
    test("should calculate recent errors correctly", async () => {
      // Add an old error (simulate by manipulating timestamp)
      const oldError = new ProcessError("Old error", "OLD");
      await errorHandler.handleError(oldError);
      
      // Manually adjust timestamp to be older than 1 hour
      const history = errorHandler.getErrorHistory();
      if (history.length > 0) {
        const oldTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
        history[0].timestamp = oldTimestamp;
      }
      
      // Add a recent error
      await errorHandler.handleError(new ProcessError("Recent error", "RECENT"));
      
      const stats = errorHandler.getErrorStats();
      expect(stats.recent).toBe(1); // Only the recent error should count
    });

    test("should get limited error history", async () => {
      // Add multiple errors
      for (let i = 0; i < 10; i++) {
        await errorHandler.handleError(new ProcessError(`Error ${i}`, `TEST_${i}`));
      }
      
      const limitedHistory = errorHandler.getErrorHistory(5);
      expect(limitedHistory).toHaveLength(5);
      
      // Should get the most recent errors
      expect(limitedHistory[0].code).toBe("TEST_9");
      expect(limitedHistory[4].code).toBe("TEST_5");
    });

    test("should clear error history", async () => {
      await errorHandler.handleError(new ProcessError("Test", "TEST"));
      expect(errorHandler.getErrorHistory()).toHaveLength(1);
      
      errorHandler.clearErrorHistory();
      expect(errorHandler.getErrorHistory()).toHaveLength(0);
      
      const stats = errorHandler.getErrorStats();
      expect(stats.total).toBe(0);
    });
  });
});

describe("Error Integration Tests", () => {
  test("should handle multiple error types in sequence", async () => {
    const handler = new ErrorHandler();
    
    // Simulate a sequence of errors that might occur in real usage
    const errors = [
      new ProcessStartupError("app1", "Script not found"),
      new ProcessCrashError("app2", 1),
      new ProcessMemoryLimitError("app3", 1000000, 500000),
      new InvalidConfigurationError(["Missing name", "Invalid instances"]),
      new IPCConnectionError("/tmp/daemon.sock", "Connection refused")
    ];
    
    for (const error of errors) {
      await handler.handleError(error);
    }
    
    const stats = handler.getErrorStats();
    expect(stats.total).toBe(5);
    expect(stats.byCategory.process).toBe(3);
    expect(stats.byCategory.config).toBe(1);
    expect(stats.byCategory.ipc).toBe(1);
    
    const history = handler.getErrorHistory();
    expect(history).toHaveLength(5);
    
    // Verify errors are in reverse chronological order (most recent first)
    expect(history[0].category).toBe("ipc");
    expect(history[4].category).toBe("process");
  });

  test("should handle error recovery scenarios", async () => {
    const handler = new ErrorHandler();
    
    // Mock process manager for recovery testing
    const mockProcessManager = {
      getRestartStats: (processId: string) => ({
        canRestart: processId !== "exhausted-app",
        restartCount: processId === "exhausted-app" ? 10 : 2,
        maxRestarts: 5
      })
    };
    
    // Test recoverable error
    const recoverableError = new ProcessCrashError("healthy-app", 1);
    const recoverableResult = await handler.handleError(recoverableError, mockProcessManager);
    expect(recoverableResult.recovered).toBe(true);
    
    // Test non-recoverable error (restart limit exceeded)
    const exhaustedError = new ProcessCrashError("exhausted-app", 1);
    const exhaustedResult = await handler.handleError(exhaustedError, mockProcessManager);
    expect(exhaustedResult.recovered).toBe(false);
    
    // Test non-recoverable error type
    const configError = new InvalidConfigurationError(["Invalid config"]);
    const configResult = await handler.handleError(configError);
    expect(configResult.recovered).toBe(false);
  });
});