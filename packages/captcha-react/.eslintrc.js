/** @type {import("eslint").Linter.Config} */
module.exports = {
  extends: [require.resolve('@shared/eslint/react.js')],
  parserOptions: {
    project: true,
  },
};
