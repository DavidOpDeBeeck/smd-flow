#!/bin/sh
# Draws the diagrams the README shows, from each example's flows before (base) and after (head) the change.
set -e
cd "$(dirname "$0")"
for example in new-flow medium-change removed-reaction group-starts-flow; do
  node ../render.mjs "$example/head.smdflow" --base "$example/base.smdflow" --out "$example/smd-flow"
done
node ../render.mjs changed-command/head.smdflow --base changed-command/base.smdflow --out changed-command/smd-flow \
  --changed ResolveTicketCommand
rm ./*/smd-flow.md
