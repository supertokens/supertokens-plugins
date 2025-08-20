#!/bin/bash

set -e  # Exit on any error

RED='\033[0;31m'
GREEN='\033[0;32m'
NO_COLOR='\033[0m'

print_status() {
    echo -e "${GREEN}[INFO]${NO_COLOR} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NO_COLOR} $1"
}

if [ ! -d ".git" ]; then
    print_error "Not in a git repository! Please run this script from the root of your git repo."
    exit 1
fi

HOOKS_DIR=".git/hooks"
if [ ! -d "$HOOKS_DIR" ]; then
    mkdir -p "$HOOKS_DIR"
    print_status "Created hooks directory"
fi


COMMIT_MSG_HOOK="$HOOKS_DIR/commit-msg"
COMMIT_MSG_HOOK_SCRIPT="./scripts/git-commit-hook.sh"
cp $COMMIT_MSG_HOOK_SCRIPT $COMMIT_MSG_HOOK
chmod +x $COMMIT_MSG_HOOK

if [ -x "$COMMIT_MSG_HOOK" ]; then
    print_status "✅ commit-msg hook is installed and executable"
else
    print_error "❌ commit-msg hook installation failed"
    exit 1
fi

PRE_PUSH_HOOK="$HOOKS_DIR/pre-push"
PRE_PUSH_HOOK_SCRIPT="./scripts/git-push-hook.sh"
cp $PRE_PUSH_HOOK_SCRIPT $PRE_PUSH_HOOK
chmod +x $PRE_PUSH_HOOK

if [ -x "$PRE_PUSH_HOOK" ]; then
    print_status "✅ pre-push hook is installed and executable"
else
    print_error "❌ pre-push hook installation failed"
    exit 1
fi

echo ""
print_status "🎉 Git commit hooks setup complete!"
echo ""
