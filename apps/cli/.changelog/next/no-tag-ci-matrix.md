- **Release CI no longer re-runs the six-job cross-platform matrix on `v*` tags.**
  The expensive `ci.yml` matrix (ubuntu + macOS + Windows × Node 22/24) still
  runs on `release/**` branch pushes and manual `workflow_dispatch`, but not when
  a version tag is pushed. `release.sh` tags the exact commit that already passed
  the release-branch matrix, so the post-tag matrix was pure cost. Source:
  `.github/workflows/ci.yml`.
