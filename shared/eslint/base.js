/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  extends: ["eslint:recommended"],
  plugins: ["turbo", "@typescript-eslint"],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: "module",
  },
  rules: {
    "turbo/no-undeclared-env-vars": "warn",
    // Disable the base no-unused-vars rule and use the TypeScript-specific one
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": "error",
  },
  ignorePatterns: [
    "*.setup.js",
    "*.config.js",
    ".eslintrc.js",
    ".prettierrc.js",
    ".turbo/",
    "dist/",
    "coverage/",
    "node_modules/",
    ".husky/",
  ],
};
