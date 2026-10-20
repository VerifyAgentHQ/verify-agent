# Durable result storage

The active VerifyAgent API uses the SQLite result registry at
`.local/verifyagent-results.sqlite`. The path can be overridden with
`VERIFY_RESULT_STORE_PATH`. This adapter replaces the JSON file registry in the
canonical runtime; the JSON implementation remains only for compatibility and
migration reference.

## Deployment guarantees

After a result transaction commits, the registry guarantees that:

- the detailed MVP result survives an API process restart;
- results are indexed by verification ID, queue-job ID, and worker job ID;
- replacement and bounded-retention updates are transactional;
- conflicting identities are rejected rather than silently overwritten;
- stored results are schema-validated and returned as immutable values;
- SQLite uses WAL journaling and `synchronous=FULL` for committed-result durability.

The persisted result includes the exact PR and commit identity, CI/check-run
evidence, deterministic requirement evidence, findings, policy decision, and
content hash used by the MVP observation path.

## Deployment contract

- Run VerifyAgent on Node.js 22.5 or newer. The adapter uses Node's built-in
  SQLite support and does not add a native database dependency.
- Mount a persistent, writable volume for the directory containing the SQLite
  file. A container filesystem or ephemeral serverless disk is not durable.
- Keep the SQLite `-wal` and `-shm` companion files with the database. Back up
  the database as a consistent SQLite backup, or stop the process before
  copying all three files together.
- Restrict access to the result directory to the VerifyAgent service account.
  Never commit the database, logs, credentials, or generated comments.
- Keep a stable `VERIFY_RESULT_STORE_PATH` across restarts and deployments.
  An unreadable or corrupt database is a deployment failure; it must not be
  treated as an empty result registry.

## Current limitations

The active canonical service uses a SQLite queue and result registry. Jobs are
recovered when a process restarts before acknowledgement; an actively
executing job is returned to pending and may run again, so verification must
remain idempotent. The adapters are intended for the current single-instance
MVP and must not be shared by multiple independent API processes. A future
distributed database/queue adapter can implement the same boundaries when
multi-instance operation is required.
