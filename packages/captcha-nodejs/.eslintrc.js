/** @type {import("eslint").Linter.Config} */
module.exports = {
  extends: [require.resolve('@shared/eslint/node.js')],
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
};
