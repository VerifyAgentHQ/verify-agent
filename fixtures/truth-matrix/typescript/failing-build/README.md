# failing-build fixture

This fixture demonstrates a deterministic BUILD-only failure.

## Expected behavior

| Command        | Exit code | Reason                                                    |
| -------------- | --------- | --------------------------------------------------------- |
| `tsc --noEmit` | 0 (pass)  | Does not validate referenced project errors               |
| `tsc --build`  | 2 (fail)  | Validates referenced project `lib` which has a type error |

## Why typecheck passes but build fails

The main project (`src/index.ts`) is type-safe. The referenced `lib` project has a deliberate type error:

```typescript
// lib/src/index.ts
export const value: string = 42; // Error: number not assignable to string
```

`tsc --noEmit` skips referenced project validation, so it passes.
`tsc --build` validates all referenced projects, so it fails.

## Fixture structure

```
failing-build/
  src/index.ts          # Type-safe source code
  tsconfig.json         # References lib project
  lib/
    src/index.ts        # Contains deliberate type error
    tsconfig.json       # composite: true project
```

## Determinism guarantees

- No machine-specific state
- No dependency on `dist` contents
- No network availability required
- No timing or environment-specific behavior
- Failure is caused by a deterministic TypeScript compiler behavior difference between `--noEmit` and `--build` modes
