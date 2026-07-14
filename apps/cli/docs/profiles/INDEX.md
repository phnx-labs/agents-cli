# Per-provider profile guides

| Provider | Host | Caveats | Doc |
|---|---|---|---|
| truefoundry | claude | Bedrock strict validation; corp cert chain | [truefoundry.md](truefoundry.md) |
| bedrock | claude | strict validation (DISABLE_PROMPT_CACHING) | [bedrock.md](bedrock.md) |
| vertex | claude | region-specific model availability | [vertex.md](vertex.md) |
| foundry | claude | Microsoft Azure AI — not TrueFoundry | [foundry.md](foundry.md) |
| openrouter | claude | print-safe vs reasoning models | [openrouter.md](openrouter.md) |
| openrouter (open-claude, claude-spark) | claude | open-claude: qwen headless-safe; claude-spark: meta/claude-spark-1.1 | [openrouter.md](openrouter.md) |
| opencode | opencode | free models via opencode auth, use --model flag | [openrouter.md](openrouter.md) |
| vllm | claude | requires native Anthropic endpoint | [vllm.md](vllm.md) |
| litellm | claude | tool_use limitations on pass-through | [litellm.md](litellm.md) |
| ollama | codex | use Codex host, not Claude Code | [ollama.md](ollama.md) |
