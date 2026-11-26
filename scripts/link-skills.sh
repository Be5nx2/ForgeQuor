#!/bin/sh
# Expose shared + forgequor skills to Claude Code (.claude/skills) and Codex (.agents/skills).
cd "$(dirname "$0")/.." || exit 1
rm -rf .claude/skills .agents/skills; mkdir -p .claude/skills .agents/skills
for d in skills/shared/*/ skills/forgequor/*/; do
  [ -f "$d/SKILL.md" ] || continue; n=$(basename "$d")
  ln -sfn "../../$d" ".claude/skills/$n"; ln -sfn "../../$d" ".agents/skills/$n"
done
