- **Placement model + `agents run --where` (Phase 2 surface consolidation).**
  "Where does the body run?" is one shared object (`local | device | fleet | cloud | lease`)
  in `src/lib/placement.ts`. `agents run --where device:<name>|auto|lease[:backend]|local`
  expands into the existing `--host` / `--lease` paths; mixing doors fails loud. Docs
  (`00-concepts.md` § Placement, `hosts.md`) and help on run / routines / monitors teach
  the matrix — including that monitors `--device` is **owner**, not body placement.
  Old flags remain aliases. Source: `apps/cli/src/lib/placement.ts`, `apps/cli/src/commands/exec.ts`.
