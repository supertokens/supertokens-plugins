/** @type {import("eslint").Linter.Config} */
module.exports = {
  extends: [require.resolve("@shared/eslint/react.js")],
  parserOptions: {
    project: true,
  },
  rules: {
    // Temporarily disable this rule due to a bug with mapped types
    "@typescript-eslint/no-unused-vars": "off",
    // Disable global type warnings for third-party types
    "no-undef": "off",
  },
  ignorePatterns: ["**/*.test.ts", "**/*.spec.ts", "tests/**/*"],
};
