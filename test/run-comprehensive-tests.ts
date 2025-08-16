#!/usr/bin/env bun

/**
 * Comprehensive Test Runner for Bun Process Manager
 * 
 * This script runs all test suites in the correct order:
 * 1. Unit tests
 * 2. Integration tests  
 * 3. Performance tests
 * 4. Stress tests
 * 5. End-to-end tests
 */

import { spawn } from "bun";
import { existsSync } from "fs";
import { resolve } from "path";

interface TestSuite {
  name: string;
  pattern: string;
  timeout?: number;
  description: string;
}

const testSuites: TestSuite[] = [
  {
    name: "Unit Tests",
    pattern: "test/*.test.ts",
    timeout: 30000,
    description: "Core component unit tests"
  },
  {
    name: "Integration Tests", 
    pattern: "test/integration/*.test.ts",
    timeout: 60000,
    description: "CLI workflow and component integration tests"
  },
  {
    name: "Performance Tests",
    pattern: "test/performance/*.test.ts", 
    timeout: 120000,
    description: "Performance benchmarks and timing tests"
  },
  {
    name: "Stress Tests",
    pattern: "test/stress/*.test.ts",
    timeout: 180000,
    description: "Concurrent operations and load testing"
  },
  {
    name: "End-to-End Tests",
    pattern: "test/e2e/*.test.ts",
    timeout: 300000,
    description: "Real process lifecycle scenarios"
  }
];

interface TestResults {
  suite: string;
  passed: boolean;
  duration: number;
  output: string;
  error?: string;
}

async function runTestSuite(suite: TestSuite): Promise<TestResults> {
  console.log(`\n🧪 Running ${suite.name}...`);
  console.log(`   ${suite.description}`);
  console.log(`   Pattern: ${suite.pattern}`);
  
  const startTime = performance.now();
  
  try {
    const proc = spawn({
      cmd: ["bun", "test", suite.pattern, "--timeout", (suite.timeout || 30000).toString()],
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd()
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text()
    ]);

    await proc.exited;
    const endTime = performance.now();
    const duration = endTime - startTime;

    const success = proc.exitCode === 0;
    
    if (success) {
      console.log(`   ✅ ${suite.name} passed (${duration.toFixed(0)}ms)`);
    } else {
      console.log(`   ❌ ${suite.name} failed (${duration.toFixed(0)}ms)`);
    }

    return {
      suite: suite.name,
      passed: success,
      duration,
      output: stdout,
      error: stderr
    };

  } catch (error) {
    const endTime = performance.now();
    const duration = endTime - startTime;
    
    console.log(`   💥 ${suite.name} crashed (${duration.toFixed(0)}ms)`);
    
    return {
      suite: suite.name,
      passed: false,
      duration,
      output: "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runAllTests(): Promise<void> {
  console.log("🚀 Starting Comprehensive Test Suite for Bun Process Manager");
  console.log("=" .repeat(60));

  const results: TestResults[] = [];
  const startTime = performance.now();

  // Run each test suite sequentially to avoid resource conflicts
  for (const suite of testSuites) {
    const result = await runTestSuite(suite);
    results.push(result);
    
    // Add a small delay between test suites to allow cleanup
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  const endTime = performance.now();
  const totalDuration = endTime - startTime;

  // Print summary
  console.log("\n" + "=" .repeat(60));
  console.log("📊 Test Results Summary");
  console.log("=" .repeat(60));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  console.log(`\nOverall: ${passed}/${total} test suites passed`);
  console.log(`Total Duration: ${(totalDuration / 1000).toFixed(1)}s`);

  // Detailed results
  console.log("\nDetailed Results:");
  results.forEach(result => {
    const status = result.passed ? "✅ PASS" : "❌ FAIL";
    const duration = `${(result.duration / 1000).toFixed(1)}s`;
    console.log(`  ${status} ${result.suite.padEnd(20)} (${duration})`);
  });

  // Show failures
  const failures = results.filter(r => !r.passed);
  if (failures.length > 0) {
    console.log("\n🔍 Failure Details:");
    failures.forEach(failure => {
      console.log(`\n--- ${failure.suite} ---`);
      if (failure.error) {
        console.log("Error:", failure.error);
      }
      if (failure.output) {
        console.log("Output:", failure.output.slice(-500)); // Last 500 chars
      }
    });
  }

  // Performance insights
  console.log("\n⚡ Performance Insights:");
  const performanceResults = results.find(r => r.suite === "Performance Tests");
  if (performanceResults && performanceResults.passed) {
    console.log("  - Daemon startup/shutdown performance: ✅");
    console.log("  - IPC communication latency: ✅");
    console.log("  - Process management throughput: ✅");
  }

  const stressResults = results.find(r => r.suite === "Stress Tests");
  if (stressResults && stressResults.passed) {
    console.log("  - Concurrent operation handling: ✅");
    console.log("  - Memory leak prevention: ✅");
    console.log("  - High load stability: ✅");
  }

  // Exit with appropriate code
  const exitCode = failed > 0 ? 1 : 0;
  console.log(`\n${failed > 0 ? "❌" : "✅"} Test suite ${failed > 0 ? "failed" : "completed successfully"}`);
  
  process.exit(exitCode);
}

// Check if we're in the right directory
const packageJsonPath = resolve(process.cwd(), "package.json");
if (!existsSync(packageJsonPath)) {
  console.error("❌ Error: package.json not found. Please run from project root.");
  process.exit(1);
}

// Check if test directories exist
const testDir = resolve(process.cwd(), "test");
if (!existsSync(testDir)) {
  console.error("❌ Error: test directory not found.");
  process.exit(1);
}

// Run the tests
runAllTests().catch(error => {
  console.error("💥 Test runner crashed:", error);
  process.exit(1);
});