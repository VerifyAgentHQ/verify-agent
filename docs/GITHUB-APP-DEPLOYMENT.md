# GitHub App installation and dogfood

This guide deploys the active VerifyAgent MVP. It does not enable the frozen
sandbox, execute repository code, or publish VerifyAgent-owned check runs.

## GitHub App configuration

Create or use a GitHub App owned by the VerifyAgent organization. Configure:

- webhook event: `Pull requests`;
- repository permissions: `Contents: Read`, `Issues: Read and write`,
  `Pull requests: Read and write`, and `Checks: Read`;
- webhook secret: a new random secret stored outside Git;
- installation: install the App on the dogfood repository or organization.

The App must be installed on the organization that owns the target repository.
An App being registered with write permissions is not sufficient if the existing
installation has not been updated or reinstalled with those permissions.

The active service reads these values at startup:

| Variable                       | Required | Meaning                                                                       |
| ------------------------------ | -------- | ----------------------------------------------------------------------------- |
| `GITHUB_APP_ID`                | yes      | Numeric GitHub App ID                                                         |
| `GITHUB_APP_PRIVATE_KEY`       | yes      | PEM private key, supplied through the secret manager or process environment   |
| `GITHUB_WEBHOOK_SECRET`        | yes      | Secret configured on the App webhook                                          |
| `VERIFY_RESULT_STORE_PATH`     | no       | Persistent SQLite path; defaults to `.local/verifyagent-results.sqlite`       |
| `VERIFY_REQUIRED_CHECKS`       | no       | Comma-separated required categories; defaults to `Build,Typecheck,Lint,Tests` |
| `VERIFY_INTERNAL_RESULT_TOKEN` | no       | Enables protected internal result observation when explicitly configured      |
| `PORT`                         | no       | HTTP port; defaults to `3000`                                                 |

Do not put the private key, webhook secret, installation token, SQLite database,
or generated logs in Git. The private key is read exactly as supplied and must
contain a PEM private-key header.

## Deployment

Build and run the canonical API from the `verify-agent` repository:

```text
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm --filter @verify-agent/api start
```

For a reproducible release artifact, build the active API image from the
repository root:

```text
docker build --tag verifyagent:<git-sha> .
docker compose -f compose.example.yml up --build -d
```

Copy `.env.example` to an ignored `.env`, fill it through the deployment
secret manager, and keep the named `verifyagent-results` volume. The image runs
as an unprivileged user, has no repository checkout or sandbox capability, and
exposes only the API port. The health check and `restart: unless-stopped`
provide explicit process-failure behavior for the example deployment.

Expose the service's HTTPS endpoint to GitHub and configure the App webhook URL
as:

```text
https://<public-host>/webhook
```

Use a persistent writable volume for the directory containing
`VERIFY_RESULT_STORE_PATH`. See [RESULT-STORAGE.md](RESULT-STORAGE.md) for the
SQLite durability and backup contract. The service must be single-instance in
the current MVP; do not point multiple independent processes at one SQLite
file.

The durable SQLite queue recovers pending and interrupted jobs after a process
restart. A verification failure is requeued by the worker, while a successful
job is acknowledged only after its detailed result commits. GitHub webhook
validation failures return `401`/`400`; unsupported routes return `404`; a
startup configuration or database failure exits the process instead of serving
an empty or unauthenticated verifier.

The health endpoint is:

```text
GET /health
```

The only production verification entrypoint is the signed GitHub webhook. The
old unauthenticated synchronous `POST /verify` endpoint is removed. A valid
supported `pull_request` event returns `202` after replay and HMAC validation,
then the in-process queue/worker evaluates it and updates one marked PR comment.

## Reproducible local dogfood

The local fixture proof uses no GitHub credentials, network calls, webhook
delivery, or external writes. It exercises requirement summaries/evidence in
the comment renderer, verdict semantics, and durable SQLite restart behavior:

```text
pnpm run dogfood:fixture
```

This is a deterministic implementation proof, not a claim that a live GitHub
installation has been tested. For a live dogfood, use a disposable PR in an
installed repository, set the variables above in the process environment, and
trigger exactly one `pull_request` event by opening or synchronizing the PR.
Record the event delivery ID, PR head SHA, queue-job ID, durable result ID, and
comment URL. Never paste tokens or private-key material into logs or comments.

## Live verification checklist

1. Confirm the App is installed on the target repository and the installation
   has the current permissions.
2. Confirm the process environment contains the three required credentials
   without printing their values.
3. Start the canonical API and verify `GET /health`.
4. Open or synchronize a disposable pull request with explicit requirements.
5. Confirm the webhook response is `202` and capture the queue-job ID.
6. Confirm the result uses the exact PR head SHA and authoritative check-runs.
7. Confirm each requirement has deterministic PASS, FAIL, or UNKNOWN evidence.
8. Confirm the durable result can be read through the protected result boundary.
9. Confirm the single `<!-- verifyagent:pr-comment -->` comment is created or
   updated and contains the result ID, policy ID, verdict, and evidence links.
10. Retain the result ID, commit SHA, and comment URL as the dogfood record.
