# ADR 0005: Platform-bound offline dependency artifacts

## Decision

Offline dependency artifacts record their operating system and architecture in
their stable identity. Provisioning may require an expected runner platform and
fails closed on mismatch. Linux artifacts reject Windows-specific paths in
package launchers; launchers are never string-rewritten after provisioning.

## Rationale

pnpm launchers and native dependencies can encode the platform and provisioning
workspace. A Windows-built tree is not a reliable input to the Linux Docker
runner. A compatible trusted build environment preserves reproducible offline
execution without copying host `node_modules` or adding runtime network.

## Trade-off

Artifacts require a trusted build environment per target platform. This is
preferable to silently accepting launchers or native binaries that cannot run in
the sandbox.
