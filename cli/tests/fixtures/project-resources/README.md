# project-resources fixture

A self-contained project tree used by tests that exercise project-level
resource discovery and sync. The shape mirrors what a real user's repo
would look like once they've added `<repo>/.agents/`.

```
project-resources/
├── repo/                          # project root (boundary: agents.yaml)
│   ├── agents.yaml                # walk-up boundary marker + version pin
│   ├── .agents/
│   │   ├── agents.yaml            # project-scoped manifest
│   │   ├── rules/
│   │   │   ├── rules.yaml         # project preset: empty default; project subrules auto-append
│   │   │   └── subrules/
│   │   │       ├── project-marker.md   # RULE_TOKEN_*
│   │   │       └── project-secret.md   # SECRET_TOKEN_*
│   │   ├── commands/
│   │   │   └── myproj.md          # CMD_TOKEN_*
│   │   ├── skills/
│   │   │   └── myskill/SKILL.md   # SKILL_TOKEN_*
│   │   └── mcp/
│   │       └── proj-mcp.yaml      # MCP_TOKEN_* in args
│   └── sub/deep/                  # nested cwd: walk-up must find <repo>/.agents
└── sibling/                       # no .agents — boundary-leak control
```

## Tokens

Deterministic strings the assertions look for:

| Token                                       | Where it lives                              |
|---------------------------------------------|---------------------------------------------|
| `RULE_TOKEN_PROJECT_LEVEL_RULE_LOADED`      | `.agents/rules/subrules/project-marker.md`  |
| `SECRET_TOKEN_FRAGMENT_INLINED`             | `.agents/rules/subrules/project-secret.md`  |
| `CMD_TOKEN_PROJECT_COMMAND_AVAILABLE`       | `.agents/commands/myproj.md`                |
| `SKILL_TOKEN_PROJECT_SKILL_AVAILABLE`       | `.agents/skills/myskill/SKILL.md`           |
| `MCP_TOKEN_PROJECT_MCP_AVAILABLE`           | `.agents/mcp/proj-mcp.yaml` (args)          |

## Usage

Tests should copy the fixture into a temp dir before mutating anything
(`compileRulesForProject` writes `<repo>/AGENTS.md`, which would dirty the
checked-in tree). The `.gitkeep` files keep the otherwise-empty `sub/deep/`
and `sibling/` directories tracked.
