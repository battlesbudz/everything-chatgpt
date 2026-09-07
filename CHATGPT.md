# Everything ChatGPT

Everything ChatGPT (ECG) is a ChatGPT- and Codex-first adaptation of the upstream Everything Claude Code harness.

## Porting principles

- Keep the upstream MIT license and attribution visible.
- Prefer provider-neutral instructions, skills, and MCP conventions.
- Treat ChatGPT and Codex as first-class targets.
- Keep Claude Code files as compatibility adapters unless they encode a generally useful workflow.
- Do not claim feature parity where a harness lacks native hooks, agents, plugins, or skill discovery.
- Prefer explicit, reviewable workflows for destructive or externally visible actions.

## Current scope

The initial fork preserves the battle-tested agents, skills, commands, rules, tests, and multi-harness adapters from upstream while establishing a ChatGPT-first identity. Subsequent work should progressively replace provider-specific assumptions with portable equivalents and add ChatGPT/Codex installation and usage paths.

## Relationship to upstream

This is a fork, not an official OpenAI repository or product. Changes inherited from upstream remain under the original project’s license and attribution. See the upstream repository for its current release notes and canonical Claude Code documentation.
