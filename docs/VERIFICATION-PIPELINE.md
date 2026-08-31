# Verification pipeline

The Phase 0 project defines the intended pipeline boundaries without implementing every stage.

```text
INGEST
→ DETECT
→ PLAN
→ EXECUTE
→ COLLECT
→ ANALYZE
→ POLICY
→ RESULT
```

## Stage definitions

- `INGEST`: obtain repository metadata and change context from a source adapter.
- `DETECT`: identify the project and determine the technical ecosystem, language, and capabilities.
- `PLAN`: convert the detected project into a concrete set of checks.
- `EXECUTE`: run the verification checks in a secure execution boundary.
- `COLLECT`: gather evidence, logs, and status from the execution pipeline.
- `ANALYZE`: convert evidence into findings and interpret observed facts.
- `POLICY`: evaluate evidence against the relevant policy definitions and outcomes.
- `RESULT`: produce a final, immutable verification result.

This document intentionally describes future behavior and does not claim implementation of later phases.
