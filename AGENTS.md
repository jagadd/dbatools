# Repository Agent Instructions

- Work, commit, and push only on `development`. Never commit or push directly to `main`.
- The user handles the `development` to `main` pull request manually.
- Preserve STDIO compatibility when changing HTTPS, authentication, or credentials.
- Keep secrets out of command arguments, logs, tests, and repository files.
- Run the available automated checks and report Windows acceptance tests separately when Windows is unavailable.
