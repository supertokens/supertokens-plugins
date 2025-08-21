#!/bin/sh

# Git commit-msg hook to enforce conventional commit format
# Format: type(optional scope): description
# Types: feat, fix, docs, style, refactor, perf, test, chore, ci, build, revert

COMMIT_FILE="$1"
COMMIT_MSG=$(cat "$COMMIT_FILE")

# Skip validation for merge commits, revert commits, and fixup/squash commits
if echo "$COMMIT_MSG" | grep -qE "^(Merge|Revert|fixup!|squash!)"; then
    exit 0
fi

# Define the regex pattern for conventional commits
# Format: type(optional scope): description
COMMIT_REGEX='^(feat|fix|docs|style|refactor|perf|test|chore|ci|build|revert)(\([a-zA-Z0-9_-]+\))?: .{1,72}$'

if ! echo "$COMMIT_MSG" | head -n1 | grep -qE "$COMMIT_REGEX"; then
    echo "❌ Invalid commit message format!"
    echo ""
    echo "Expected format: type(optional scope): description"
    echo ""
    echo "Valid types:"
    echo "  feat:     A new feature"
    echo "  fix:      A bug fix"
    echo "  docs:     Documentation changes"
    echo "  style:    Code style changes (formatting, etc.)"
    echo "  refactor: Code refactoring"
    echo "  perf:     Performance improvements"
    echo "  test:     Adding or updating tests"
    echo "  chore:    Maintenance tasks"
    echo "  ci:       CI/CD changes"
    echo "  build:    Build system changes"
    echo "  revert:   Reverting changes"
    echo ""
    echo "Examples:"
    echo "  feat(captcha-react): Add conditional validation"
    echo "  fix: resolve input rendering bug"
    echo ""
    echo "Your commit message:"
    echo "  $(echo "$COMMIT_MSG" | head -n1)"
    echo ""
    exit 1
fi
