export default {
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
};
