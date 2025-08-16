import { test, expect, describe } from "bun:test";
import { spawn } from "bun";
import { join } from "path";

describe("CLI Interface", () => {
  const cliPath = join(import.meta.dir, "../src/cli/index.ts");

  test("should show help when no arguments provided", async () => {
    const proc = spawn({
      cmd: ["bun", cliPath],
      stdout: "pipe",
      stderr: "pipe"
    });

    const output = await new Response(proc.stdout).text();
    expect(output).toContain("bun-pm - Bun Process Manager");
    expect(output).toContain("USAGE:");
    expect(output).toContain("COMMANDS:");
  });

  test("should show help with --help flag", async () => {
    const proc = spawn({
      cmd: ["bun", cliPath, "--help"],
      stdout: "pipe",
      stderr: "pipe"
    });

    const output = await new Response(proc.stdout).text();
    expect(output).toContain("bun-pm - Bun Process Manager");
    expect(output).toContain("start <script|config>");
    expect(output).toContain("stop <name|id>");
    expect(output).toContain("restart <name|id>");
    expect(output).toContain("list, ls");
  });

  test("should show version with --version flag", async () => {
    const proc = spawn({
      cmd: ["bun", cliPath, "--version"],
      stdout: "pipe",
      stderr: "pipe"
    });

    const output = await new Response(proc.stdout).text();
    expect(output).toMatch(/bun-pm v\d+\.\d+\.\d+/);
  });

  test("should show error for unknown command", async () => {
    const proc = spawn({
      cmd: ["bun", cliPath, "unknown-command"],
      stdout: "pipe",
      stderr: "pipe"
    });

    const error = await new Response(proc.stderr).text();
    expect(error).toContain("Unknown command: unknown-command");
    expect(error).toContain('Run "bun-pm --help" for usage information');
  });

  test("should show error for start command without script", async () => {
    const proc = spawn({
      cmd: ["bun", cliPath, "start"],
      stdout: "pipe",
      stderr: "pipe"
    });

    const error = await new Response(proc.stderr).text();
    expect(error).toContain("Script path or ecosystem file is required");
    expect(error).toContain("Usage: bun-pm start <script|ecosystem.json> [options]");
  });

  test("should show error for stop command without identifier", async () => {
    const proc = spawn({
      cmd: ["bun", cliPath, "stop"],
      stdout: "pipe",
      stderr: "pipe"
    });

    const error = await new Response(proc.stderr).text();
    expect(error).toContain("Process name or ID is required");
    expect(error).toContain("Usage: bun-pm stop <name|id>");
  });

  test("should show error for restart command without identifier", async () => {
    const proc = spawn({
      cmd: ["bun", cliPath, "restart"],
      stdout: "pipe",
      stderr: "pipe"
    });

    const error = await new Response(proc.stderr).text();
    expect(error).toContain("Process name or ID is required");
    expect(error).toContain("Usage: bun-pm restart <name|id>");
  });

  test("should handle list command when daemon not running", async () => {
    const proc = spawn({
      cmd: ["bun", cliPath, "list"],
      stdout: "pipe",
      stderr: "pipe"
    });

    const output = await new Response(proc.stdout).text();
    expect(output).toContain("No processes running");
  });
});