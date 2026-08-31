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
  respond(request);
});

function respond(request) {
  if (request.snapshot === "malformed") {
    process.stdout.write("not-json\n");
    return;
  }
  if (request.snapshot === "large") {
    process.stdout.write(
      JSON.stringify({ ...result(request), logsRef: "x".repeat(5000) }) + "\n",
    );
    return;
  }
  process.stdout.write(JSON.stringify(result(request)) + "\n");
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
