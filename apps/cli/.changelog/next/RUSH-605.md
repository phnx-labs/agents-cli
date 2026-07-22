Added top-level resource profiles via `agents profile use`, filtering synced resources and secrets bundles by the active profile.
Fixed source-qualified resource profile selectors for permission groups and workflows so `project:`, `user:`, and `system:` patterns match the real resource layer.
Fixed `resolveResource` to fall through to lower-precedence layers when a higher-layer match is excluded by the active profile, matching `listResources` behavior.
