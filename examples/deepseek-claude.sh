#!/usr/bin/env bash
# Example: point the `claude` CLI at DeepSeek for a single invocation,
# without touching any global config.
#
# Prereqs: `claude` on PATH, a DeepSeek API key, and cli-provider-router
# installed (`npm i -g cli-provider-router`) or run via `npx cpr`.
set -euo pipefail

DEEPSEEK_KEY="${DEEPSEEK_API_KEY:-sk-your-deepseek-key}"

# 1) Register the provider (idempotent-ish: re-running adds a second entry, so
#    remove first if you like — this is just a demo).
cpr add deepseek \
  --app claude \
  --base-url https://api.deepseek.com \
  --token "$DEEPSEEK_KEY" \
  --model deepseek-chat

# 2) Confirm it's there.
cpr list --app claude

# 3) Run claude routed to DeepSeek. Everything after `--` is the real command;
#    stdio is inherited, so interactive mode, colors, and exit codes all work.
cpr use deepseek -- claude -p "Write a haiku about routing CLIs to providers."

# 4) Interactive session on the same provider:
# cpr use deepseek -- claude

# 5) Clean up the demo provider.
# cpr rm deepseek
