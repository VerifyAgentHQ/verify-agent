export default {
  root: ".",
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/fixtures/**",
      "**/.pnpm-store/**",
    ],
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
    environment: "node",
  },
  css: {
    postcss: {},
  },
};
