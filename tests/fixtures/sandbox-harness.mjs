let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  const request = JSON.parse(input.trim());

  if (request.snapshot === "timeout" || request.snapshot === "cancel") {
    setTimeout(() => respond(request), 5000);
    return;
  }

  if (request.snapshot === "eof-no-output") {
    process.stdout.end();
    return;
  }

  respond(request);
});

function respond(request) {
  switch (request.snapshot) {
    case "malformed":
      process.stdout.write("not-json\n");
      return;
    case "large":
      process.stdout.write(
        JSON.stringify({ ...result(request), logsRef: "x".repeat(5000) }) +
          "\n",
      );
      return;
    case "wrong-version": {
      const r = result(request);
      r.schemaVersion = "2.0.0";
      process.stdout.write(JSON.stringify(r) + "\n");
      return;
    }
    case "job-mismatch": {
      const r = result(request);
      r.jobId = request.jobId + "-wrong";
      process.stdout.write(JSON.stringify(r) + "\n");
      return;
    }
    case "missing-fields": {
      process.stdout.write(JSON.stringify({ schemaVersion: "1.0.0" }) + "\n");
      return;
    }
    case "wrong-type": {
      const r = result(request);
      r.status = 123;
      r.durationMs = "not-a-number";
      process.stdout.write(JSON.stringify(r) + "\n");
      return;
    }
    case "extra-output": {
      process.stdout.write("diagnostic line before result\n");
      process.stdout.write(JSON.stringify(result(request)) + "\n");
      process.stdout.write("diagnostic line after result\n");
      return;
    }
    case "error-result": {
      const r = result(request);
      r.status = "error";
      r.errors = ["sandbox internal error"];
      process.stdout.write(JSON.stringify(r) + "\n");
      return;
    }
    case "timed_out-result": {
      const r = result(request);
      r.status = "timed_out";
      process.stdout.write(JSON.stringify(r) + "\n");
      return;
    }
    case "cancelled-result": {
      const r = result(request);
      r.status = "cancelled";
      process.stdout.write(JSON.stringify(r) + "\n");
      return;
    }
    case "resource-usage": {
      const r = result(request);
      r.resourceUsage = { memoryBytes: 1024 * 1024, cpuTimeMs: 50 };
      process.stdout.write(JSON.stringify(r) + "\n");
      return;
    }
    case "exit-code-nonzero": {
      const r = result(request);
      r.exitCode = 1;
      r.status = "failed";
      process.stdout.write(JSON.stringify(r) + "\n");
      return;
    }
    case "valid-json-nonzero-exit": {
      const r = result(request);
      r.exitCode = 1;
      r.status = "failed";
      process.stdout.write(JSON.stringify(r) + "\n");
      process.exitCode = 1;
      return;
    }
    case "with-artifacts": {
      const r = result(request);
      r.artifactRefs = ["fixture://artifacts/report.json"];
      process.stdout.write(JSON.stringify(r) + "\n");
      return;
    }
    case "error-exit-code-2": {
      process.stderr.write("process error on stderr\n");
      process.exit(2);
    }
    default:
      process.stdout.write(JSON.stringify(result(request)) + "\n");
      return;
  }
}

function result(request) {
  return {
    schemaVersion: "1.0.0",
    jobId: request.jobId,
    status: "completed",
    exitCode: request.snapshot === "failed" ? 1 : 0,
    durationMs: 1,
    logsRef: "fixture://logs",
    artifactRefs: [],
    resourceUsage: { memoryBytes: 0, cpuTimeMs: 0 },
    errors: [],
  };
}
