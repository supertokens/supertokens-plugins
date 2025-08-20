#!/bin/bash

RED='\033[0;31m'
GREEN='\033[0;32m'
NO_COLOR='\033[0m'

print_status() {
    echo -e "${GREEN}[INFO]${NO_COLOR} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NO_COLOR} $1"
}


FILES_TO_STASH_COUNT=`git ls-files . --exclude-standard --others -m | wc -l`
if [ $FILES_TO_STASH_COUNT -ne 0 ]
then
   print_status "Stashing non-staged changes"
   files_to_stash=`git ls-files . --exclude-standard --others -m | xargs`
   git stash push -k -u -- $files_to_stash >/dev/null 2>/dev/null
fi

print_status "Running linting"
npm run lint --affected >/dev/null 2>/dev/null
LINT_EXIT_CODE=$?

if [ $LINT_EXIT_CODE -eq 0 ]
then
    print_status "Linting passed"
else
    print_error "Linting failed"
    print_error "Please run 'npm run lint --affected' and fix the errors."
fi

print_status "Running build"
npm run build --affected >/dev/null 2>/dev/null
BUILD_EXIT_CODE=$?

if [ $BUILD_EXIT_CODE -eq 0 ]
then
    print_status "Build passed"
else
    print_error "Build failed"
    print_error "Please run 'npm run build --affected' and fix the build errors."
fi

if [ $FILES_TO_STASH_COUNT -ne 0 ]
then
    print_status "Applying stashed changes"
   git stash apply >/dev/null 2>/dev/null
   if [ $? -ne 0 ]
   then
      git checkout --theirs . >/dev/null 2>/dev/null
   fi
   git stash drop >/dev/null 2>/dev/null
fi

if [ $LINT_EXIT_CODE -ne 0 ] || [ $BUILD_EXIT_CODE -ne 0 ]
then
    print_error "Push cancelled due errors"
   exit 1
fi

print_status "Checks passed. Proceeding with push."
