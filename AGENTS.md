# Repository Agent Instructions

## Branch Policy

- Treat `development` as the default working branch. Perform all repository changes, commits, and pushes on `development` only.
- Before editing files, committing, or pushing, verify that the current branch is `development`. If necessary, switch to `development` without discarding existing work.
- Never commit or push directly to `main`.

## Authoritative Guidance

Follow `CLAUDE.md` for repository-wide PowerShell style and workflow conventions. It applies to every PowerShell file under `public/`, `private/`, `tests/`, and the repository scripts.

Follow `tests/CLAUDE.md` before changing command behavior or tests. It is the single source for ongoing test policy, including real-boundary behavioral and integration coverage. Do not copy those rules into agent-specific instructions.
