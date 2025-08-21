module.exports = {
  extends: [
    "./base.js",
    "plugin:react/recommended",
    "plugin:react-hooks/recommended",
  ],
  plugins: ["react", "react-hooks", "import"],
  settings: {
    react: {
      version: "detect",
    },
  },
  env: {
    browser: true,
    es6: true,
  },
  globals: {
    React: "readable",
    jsx: "readable",
  },
  rules: {
    // Disable requirement to import React in scope for JSX (not needed in React 17+)
    "react/react-in-jsx-scope": "off",
    // Disable prop-types validation (using TypeScript for type checking instead)
    "react/prop-types": "off",
    // Prevent string literals in JSX to enforce consistent text handling
    "react/jsx-no-literals": [
      "error",
      {
        noStrings: true,
        ignoreProps: true,
        allowedStrings: ["+", ":", "*", "!", "SuperTokens", "Not implemented"],
      },
    ],
    // Ensure hooks are only called in valid contexts
    "react-hooks/rules-of-hooks": "error",
    // Warn about missing dependencies in hook dependency arrays
    "react-hooks/exhaustive-deps": "warn",
    // Enforce double quotes for string literals
    quotes: ["error", "double"],
    // Require semicolons at the end of statements
    semi: ["error", "always"],
    // Enforce one true brace style (opening brace on same line)
    "brace-style": ["error", "1tbs"],
    // Disallow implicit type coercion
    "no-implicit-coercion": [
      2,
      {
        boolean: true,
        number: true,
        string: true,
      },
    ],
    // Require curly braces around all control statements
    curly: ["error"],
    // Require === and !== instead of == and != (smart allows null checks)
    eqeqeq: ["error", "smart"],
    // Require identifiers to match specified regular expressions
    "id-match": "error",
    // Disallow use of eval() function
    "no-eval": "error",
    // Disallow trailing whitespace at the end of lines
    "no-trailing-spaces": "error",
    // Disallow control flow statements in finally blocks
    "no-unsafe-finally": "error",
    // Require let or const instead of var
    "no-var": "error",
    // Enforce consistent spacing after comment delimiters
    "spaced-comment": [
      "error",
      "always",
      {
        markers: ["/"],
      },
    ],
    // Enforce consistent spacing around keywords
    "keyword-spacing": ["error"],
    // Require spacing around infix operators
    "space-infix-ops": ["error"],
    // Enforce spacing before and after semicolons
    "semi-spacing": ["error"],
    // Enforce spacing before and after commas
    "comma-spacing": ["error"],
    // Disallow empty block statements (except catch blocks)
    "no-empty": ["error", { allowEmptyCatch: true }],
    // Disallow console statements except for info, error, and warn
    "no-console": ["error", { allow: ["info", "error", "warn"] }],
    // Enforce consistent import order and grouping
    "import/order": [
      "error",
      {
        groups: [
          "builtin",
          "external",
          "internal",
          "parent",
          "sibling",
          "object",
          "type",
        ],
        "newlines-between": "always",
        alphabetize: {
          order: "asc",
          caseInsensitive: true,
        },
      },
    ],
  },
  overrides: [
    {
      files: ["**/validators.ts"],
      rules: {
        "@typescript-eslint/explicit-module-boundary-types": ["off"],
      },
    },
  ],
};
