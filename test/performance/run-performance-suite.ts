#!/usr/bin/env bun

/**
 * Comprehensive performance test suite runner
 * This script runs all performance tests and generates a performance report
 */

import { spawn } from "bun";
import { writeFileSync } from "fs";
import { resolve } from "path";

interface TestResult {
  testFile: string;
  testName: string;
  duration: number;
  status: 'pass' | 'fail';
  output: string;
}

class PerformanceTestRunner {
  private results: TestResult[] = [];

  async runTestFile(testFile: string): Promise<void> {
    console.log(`\n🧪 Running ${testFile}...`);
    
    try {
      const proc = spawn({
        cmd: ["bun", "test", testFile, "--timeout", "120000"],
        stdout: "pipe",
        stderr: "pipe"
      });

      const output = await new Response(proc.stdout).text();
      const errorOutput = await new Response(proc.stderr).text();
      const fullOutput = output + errorOutput;

      // Parse test results from output
      this.parseTestResults(testFile, fullOutput);

      if (proc.exitCode === 0) {
        console.log(`✅ ${testFile} completed successfully`);
      } else {
        console.log(`❌ ${testFile} failed`);
        console.log(fullOutput);
      }
    } catch (error) {
      console.error(`Error running ${testFile}:`, error);
      this.results.push({
        testFile,
        testName: "Test execution failed",
        duration: 0,
        status: 'fail',
        output: String(error)
      });
    }
  }

  private parseTestResults(testFile: string, output: string): void {
    // Extract timing information from test output
    const lines = output.split('\n');
    
    for (const line of lines) {
      // Look for timing patterns like "Daemon startup time: 11.22ms"
      const timingMatch = line.match(/([^:]+):\s*(\d+\.?\d*)\s*ms/);
      if (timingMatch) {
        const [, testName, duration] = timingMatch;
        this.results.push({
          testFile,
          testName: testName.trim(),
          duration: parseFloat(duration),
          status: 'pass',
          output: line
        });
      }

      // Look for test pass/fail indicators
      const testMatch = line.match(/✓\s+(.+?)\s+\[(\d+\.?\d*)\s*ms\]/);
      if (testMatch) {
        const [, testName, duration] = testMatch;
        this.results.push({
          testFile,
          testName: testName.trim(),
          duration: parseFloat(duration),
          status: 'pass',
          output: line
        });
      }
    }
  }

  generateReport(): void {
    console.log("\n" + "=".repeat(80));
    console.log("🚀 PERFORMANCE TEST REPORT");
    console.log("=".repeat(80));

    // Group results by test file
    const groupedResults = this.results.reduce((acc, result) => {
      if (!acc[result.testFile]) {
        acc[result.testFile] = [];
      }
      acc[result.testFile].push(result);
      return acc;
    }, {} as Record<string, TestResult[]>);

    let totalTests = 0;
    let passedTests = 0;
    let totalDuration = 0;

    for (const [testFile, results] of Object.entries(groupedResults)) {
      console.log(`\n📁 ${testFile}`);
      console.log("-".repeat(60));

      for (const result of results) {
        const status = result.status === 'pass' ? '✅' : '❌';
        const duration = result.duration.toFixed(2);
        console.log(`${status} ${result.testName}: ${duration}ms`);
        
        totalTests++;
        if (result.status === 'pass') passedTests++;
        totalDuration += result.duration;
      }
    }

    // Performance benchmarks and thresholds
    console.log("\n" + "=".repeat(80));
    console.log("📊 PERFORMANCE BENCHMARKS");
    console.log("=".repeat(80));

    const benchmarks = [
      { name: "Daemon startup time", threshold: 100, unit: "ms" },
      { name: "IPC connection time", threshold: 10, unit: "ms" },
      { name: "Process start response time", threshold: 200, unit: "ms" },
      { name: "List command response time", threshold: 50, unit: "ms" },
      { name: "Daemon shutdown time", threshold: 50, unit: "ms" }
    ];

    for (const benchmark of benchmarks) {
      const result = this.results.find(r => 
        r.testName.toLowerCase().includes(benchmark.name.toLowerCase())
      );
      
      if (result) {
        const status = result.duration <= benchmark.threshold ? '✅' : '⚠️';
        const percentage = ((result.duration / benchmark.threshold) * 100).toFixed(1);
        console.log(`${status} ${benchmark.name}: ${result.duration.toFixed(2)}${benchmark.unit} (${percentage}% of threshold)`);
      }
    }

    // Summary
    console.log("\n" + "=".repeat(80));
    console.log("📈 SUMMARY");
    console.log("=".repeat(80));
    console.log(`Total tests: ${totalTests}`);
    console.log(`Passed: ${passedTests}`);
    console.log(`Failed: ${totalTests - passedTests}`);
    console.log(`Success rate: ${((passedTests / totalTests) * 100).toFixed(1)}%`);
    console.log(`Total execution time: ${totalDuration.toFixed(2)}ms`);

    // Generate JSON report
    const jsonReport = {
      timestamp: new Date().toISOString(),
      summary: {
        totalTests,
        passedTests,
        failedTests: totalTests - passedTests,
        successRate: (passedTests / totalTests) * 100,
        totalDuration
      },
      results: this.results,
      benchmarks: benchmarks.map(b => {
        const result = this.results.find(r => 
          r.testName.toLowerCase().includes(b.name.toLowerCase())
        );
        return {
          ...b,
          actualValue: result?.duration || null,
          passed: result ? result.duration <= b.threshold : false
        };
      })
    };

    const reportPath = resolve("performance-report.json");
    writeFileSync(reportPath, JSON.stringify(jsonReport, null, 2));
    console.log(`\n📄 Detailed report saved to: ${reportPath}`);
  }

  async runAll(): Promise<void> {
    const testFiles = [
      "test/performance/daemon-startup.test.ts",
      "test/performance/process-management.test.ts", 
      "test/performance/memory-optimization.test.ts"
    ];

    console.log("🚀 Starting Performance Test Suite");
    console.log(`Running ${testFiles.length} test files...`);

    for (const testFile of testFiles) {
      await this.runTestFile(testFile);
    }

    this.generateReport();
  }
}

// Run the performance test suite
const runner = new PerformanceTestRunner();
runner.runAll().catch(error => {
  console.error("Performance test suite failed:", error);
  process.exit(1);
});