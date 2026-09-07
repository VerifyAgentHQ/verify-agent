/**
 * Host-subprocess execution harness for Batch 43.
 *
 * This harness runs directly on the host machine, NOT inside a Docker
 * container or any isolated sandbox. It is used for host-subprocess E2E
 * tests that verify real toolchain execution and status mapping.
 *
 * For real verify-sandbox E2E tests, see batch-43-real-sandbox.test.ts.
 *
 * Reads a SandboxJobRequest JSON from stdin, executes the first command as a
 * child process, captures stdout/stderr/exit code, and writes a valid
 * SandboxJobResult JSON to stdout.
 *
 * The harness respects the sandbox contract:
 *   - shell: false (no shell interpretation)
 *   - explicit environment (no inherited host env)
 *   - bounded output
 *   - job ID binding
 *
 * Environment variables:
 *   VERIFY_SANDBOX_WORKING_DIRECTORY — cwd for command execution (required)
 *   VERIFY_SANDBOX_TIMEOUT_MS — per-command timeout override (optional, default 60000)
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  try {
    const request = JSON.parse(input.trim());
    handleRequest(request);
  } catch (error) {
    writeResult({
      schemaVersion: "1.0.0",
      jobId: "unknown",
      status: "error",
      exitCode: 1,
      durationMs: 0,
      logsRef: "fixture://logs/error",
      artifactRefs: [],
      resourceUsage: { memoryBytes: 0, cpuTimeMs: 0 },
      errors: [`harness parse error: ${error.message}`],
    });
  }
});

function handleRequest(request) {
  const jobId = request.jobId;
  const workingDirectory = process.env.VERIFY_SANDBOX_WORKING_DIRECTORY;
  const timeoutMs = Number(process.env.VERIFY_SANDBOX_TIMEOUT_MS) || 60_000;

  if (!workingDirectory) {
    writeResult({
      schemaVersion: "1.0.0",
      jobId,
      status: "error",
      exitCode: 1,
      durationMs: 0,
      logsRef: "fixture://logs/error",
      artifactRefs: [],
      resourceUsage: { memoryBytes: 0, cpuTimeMs: 0 },
      errors: ["VERIFY_SANDBOX_WORKING_DIRECTORY is not set"],
    });
    return;
  }

  if (!request.commands || request.commands.length === 0) {
    writeResult({
      schemaVersion: "1.0.0",
      jobId,
      status: "error",
      exitCode: 1,
      durationMs: 0,
      logsRef: "fixture://logs/error",
      artifactRefs: [],
      resourceUsage: { memoryBytes: 0, cpuTimeMs: 0 },
      errors: ["no commands in request"],
    });
    return;
  }

  let command;
  try {
    command = JSON.parse(request.commands[0]);
  } catch {
    writeResult({
      schemaVersion: "1.0.0",
      jobId,
      status: "error",
      exitCode: 1,
      durationMs: 0,
      logsRef: "fixture://logs/error",
      artifactRefs: [],
      resourceUsage: { memoryBytes: 0, cpuTimeMs: 0 },
      errors: ["failed to parse command JSON"],
    });
    return;
  }

  const startTime = Date.now();
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const maxOutputBytes = 10 * 1024 * 1024; // 10 MiB contract limit

  // On Windows, spawn with shell:false cannot find .CMD files (like pnpm.cmd).
  // Wrap with cmd.exe and let it find the .CMD file via PATH.
  let executable = command.executable;
  let args = [...(command.args || [])];
  if (process.platform === "win32") {
    if (!existsSync(executable) && !executable.includes("\\")) {
      executable = join(
        process.env.SYSTEMROOT ?? "C:\\Windows",
        "System32",
        "cmd.exe",
      );
      args = ["/s", "/c", command.executable, ...args];
    }
  }

  const child = spawn(executable, args, {
    cwd: workingDirectory,
    env: {
      // Pass PATH from the transport environment so child processes can
      // find executables. The real sandbox has toolchains pre-installed in
      // the Docker image; locally we need PATH for development.
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(command.environment || {}),
    },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    if (stdoutBytes < maxOutputBytes) {
      const remaining = maxOutputBytes - stdoutBytes;
      const retained = chunk.subarray(0, remaining);
      stdoutChunks.push(retained);
      stdoutBytes += retained.length;
    }
  });

  child.stderr.on("data", (chunk) => {
    if (stderrBytes < maxOutputBytes) {
      const remaining = maxOutputBytes - stderrBytes;
      const retained = chunk.subarray(0, remaining);
      stderrChunks.push(retained);
      stderrBytes += retained.length;
    }
  });

  let killed = false;
  let responded = false;
  const timer = setTimeout(() => {
    killed = true;
    child.kill();
  }, timeoutMs);

  child.on("error", (error) => {
    clearTimeout(timer);
    if (responded) return;
    responded = true;
    const durationMs = Date.now() - startTime;
    writeResult({
      schemaVersion: "1.0.0",
      jobId,
      status: "error",
      exitCode: 1,
      durationMs,
      logsRef: "fixture://logs/error",
      artifactRefs: [],
      resourceUsage: { memoryBytes: 0, cpuTimeMs: durationMs },
      errors: [`process error: ${error.message}`],
    });
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    if (responded) return;
    responded = true;
    const durationMs = Date.now() - startTime;
    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");

    if (killed) {
      writeResult({
        schemaVersion: "1.0.0",
        jobId,
        status: "timed_out",
        durationMs,
        logsRef: "fixture://logs/timeout",
        artifactRefs: [],
        resourceUsage: { memoryBytes: 0, cpuTimeMs: durationMs },
        errors: ["command timed out"],
      });
      return;
    }

    const exitCode = code ?? 1;
    // Always return status: "completed" for command execution. The exit code
    // indicates success (0) or failure (non-zero). This matches the simulated
    // harness contract where "completed" means the sandbox finished executing,
    // and the exit code carries the command outcome.
    const status = "completed";
    const errors = [];
    if (stderr.length > 0) {
      // Include first 4096 chars of stderr as error detail
      errors.push(stderr.slice(0, 4096));
    }

    writeResult({
      schemaVersion: "1.0.0",
      jobId,
      status,
      exitCode,
      durationMs,
      logsRef: `fixture://logs/${jobId}`,
      artifactRefs: [],
      resourceUsage: {
        memoryBytes: 0,
        cpuTimeMs: durationMs,
      },
      errors,
    });
  });
}

function writeResult(result) {
  process.stdout.write(JSON.stringify(result) + "\n");
}
