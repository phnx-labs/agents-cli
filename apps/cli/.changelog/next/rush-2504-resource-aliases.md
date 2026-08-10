- **Skills and commands can declare `aliases:` in their frontmatter.** Resource
  resolution now matches a declared alias in addition to the canonical file/dir
  name, so `resolveResource('skills', 'browser')` finds a skill that lists
  `browser` among its `aliases:`. The canonical name always wins a collision — a
  real resource named `browser` beats any resource that merely aliases it, in any
  layer — and layer precedence (project > user > system) still applies among
  aliases. `listResources` surfaces each resource's `aliases`. This is the
  prerequisite for housing a resource under a plugin namespace (e.g. `agi:browser`)
  while a bare name keeps resolving. (RUSH-2504)
