---
name: Workspace dependency installs
description: A safe fallback for installing dependencies in this pnpm monorepo
---

When workspace dependencies are already declared and the package installer rejects a package-scoped request, use the repository's frozen lockfile install rather than changing dependency versions or adding packages to the workspace root.

**Why:** Package-scoped installation can fall back to the monorepo root and fail with pnpm's workspace-root protection; the lockfile already contains the intended dependency graph.

**How to apply:** Check that package manifests and the lockfile are present, then run the frozen install without cleanup or removal flags.