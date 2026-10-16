/** @type {import("eslint").Linter.Config} */
module.exports = {
  extends: [require.resolve('@shared/eslint/node.js')],
  env: { es6: true },
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  ignorePatterns: ['**/*.test.ts', '**/*.spec.ts'],
};
