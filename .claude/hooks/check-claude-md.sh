#!/bin/bash
# PostToolUse hook: reminds agent to update CLAUDE.md after structural edits
# Stdout with exit 0 becomes context the agent sees and can act on.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

DIR=$(dirname "$FILE_PATH")

# Walk up to find the nearest CLAUDE.md
CLAUDE_MD=""
CHECK_DIR="$DIR"
while [ "$CHECK_DIR" != "/" ]; do
  if [ -f "$CHECK_DIR/CLAUDE.md" ]; then
    CLAUDE_MD="$CHECK_DIR/CLAUDE.md"
    break
  fi
  CHECK_DIR=$(dirname "$CHECK_DIR")
done

# Only remind if we found a CLAUDE.md and the edited file isn't a CLAUDE.md itself
BASENAME=$(basename "$FILE_PATH")
if [ -n "$CLAUDE_MD" ] && [ "$BASENAME" != "CLAUDE.md" ]; then
  echo "Note: You edited $FILE_PATH. If this changes architecture, conventions, or key patterns, update $CLAUDE_MD to keep it current for future agents."
fi

exit 0
