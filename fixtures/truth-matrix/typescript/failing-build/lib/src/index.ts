// This file has a type error that only manifests during build.
// tsc --noEmit passes because it doesn't check referenced projects.
// tsc --build fails because it validates referenced projects.
export const value: string = 42;
