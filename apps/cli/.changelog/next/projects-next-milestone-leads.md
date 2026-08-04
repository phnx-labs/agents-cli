- **The compact `projects status` card shows the milestone it calls `next`.** Milestones are
  listed in date order, and Linear can flag a later-dated one as next — so slicing the front
  of the list showed an earlier milestone while burying the actual next under `+N more`, which
  is the one thing that row exists to say. The next milestone now leads, and identity is
  matched on name plus target date rather than name alone (two milestones can share a name,
  which put the `next` label on the wrong row). Source: `apps/cli/src/commands/projects.ts`.
