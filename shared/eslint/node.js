/** @type {import("eslint").Linter.Config} */
module.exports = {
  extends: ["./base.js"],
  env: {
    node: true,
    jest: true,
  },
  rules: {
    // Class naming (PascalCase)
    "@typescript-eslint/naming-convention": [
      "error",
      {
        selector: "class",
        format: ["PascalCase"],
      },
      {
        selector: "variable",
        format: ["camelCase", "PascalCase", "UPPER_CASE"],
        filter: {
          regex:
            "^(break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|function|if|import|in|instanceof|new|null|return|super|switch|this|throw|true|try|typeof|var|void|while|with|yield)$",
          match: false,
        },
      },
    ],
    // Comment formatting (space after //)
    "spaced-comment": ["error", "always"],
    // Indentation (spaces)
    indent: ["error", 2],
    // No duplicate variables
    "no-redeclare": "error",
    // No eval
    "no-eval": "error",
    // No trailing whitespace
    "no-trailing-spaces": "error",
    // No unsafe finally
    "no-unsafe-finally": "error",
    // One line (brace style)
    "brace-style": ["error", "1tbs", { allowSingleLine: true }],
    // Quotemark (double quotes)
    quotes: ["error", "double"],
    // Semicolon (always)
    semi: ["error", "always"],
    "semi-spacing": ["error"],
    // Triple equals (allow null check)
    eqeqeq: ["error", "always", { null: "ignore" }],
    // TypeScript specific: no var keyword
    "no-var": "error",
    // Whitespace rules
    "space-before-blocks": "error",
    "keyword-spacing": "error",
    "space-infix-ops": "error",
    "comma-spacing": ["error", { before: false, after: true }],
    "space-before-function-paren": [
      "error",
      {
        anonymous: "always",
        named: "never",
        asyncArrow: "always",
      },
    ],
  },
};
