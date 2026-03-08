# AGENTS.md

## Project Purpose

This project installs Minecraft Bedrock packs into a world from `.mcaddon`, `.mcpack`, `.zip`, or already-extracted folders.

The current architecture is a small Python package with a thin top-level script:

- `bedrock_pack_installer.py`: entrypoint
- `bedrock_pack_installer/cli.py`: CLI parsing and startup
- `bedrock_pack_installer/install.py`: install flow
- `bedrock_pack_installer/commands.py`: rebuild, zip, beta commands
- `bedrock_pack_installer/worlds.py`: world JSON helpers and selection
- `bedrock_pack_installer/manifests.py`: manifest parsing and classification
- `bedrock_pack_installer/nbt.py`: `level.dat` experiment toggles
- `bedrock_pack_installer/logger.py`: run log capture
- `bedrock_pack_installer/paths.py`: runtime path layout
- `bedrock_pack_installer/console.py`: console output helpers

## Runtime Layout

Do not put runtime data in the repo root.

All runtime data belongs under `run/`:

- `run/install/`
- `run/installed/`
- `run/behavior_packs/`
- `run/resource_packs/`
- `run/worlds/`
- `run/logs/`

If you add any new operational output, cache, report, or temp artifact, place it under `run/` unless there is a strong reason not to.

## CLI Conventions

Use `argparse` in `bedrock_pack_installer/cli.py`.

Current public commands:

- default install: `python bedrock_pack_installer.py`
- rebuild: `python bedrock_pack_installer.py --rebuild`
- zip: `python bedrock_pack_installer.py --zip`
- beta toggle: `python bedrock_pack_installer.py --beta`

When adding CLI options:

- keep `python bedrock_pack_installer.py --help` accurate
- prefer explicit flags over implicit behavior
- preserve existing workflows unless the user asked for a breaking change

## Logging

Run logs are captured automatically through `bedrock_pack_installer/logger.py`.

Rules:

- keep logs in `run/logs/`
- keep `latest.txt`
- keep the 5 most recent timestamped logs
- prefer plain-text logs
- do not add a second unrelated logging mechanism unless necessary

## Testing

Primary command:

```bash
pytest
```

Coverage is enabled by default from `pyproject.toml`.

Expected outputs:

- terminal test results
- terminal coverage report
- `coverage.xml`

If stdout capture behaves oddly in the current environment, `pytest -s` is acceptable for diagnosis, but normal work should keep `pytest` green.

## Test Data

Use fixtures.

Project test data lives under `tests/fixtures/`:

- `tests/fixtures/installed/`
- `tests/fixtures/worlds/World/`

Rules for fixture use:

- prefer fixture-driven tests for archive/install/world flows
- keep fixtures minimal, stable, and easy to understand
- fixtures should still be structurally realistic
- if fixture contents change, update fixture validation tests too

Fixture support files:

- `tests/test_fixtures.py`: validates fixture contents
- `tests/fixtures/build_fixtures.py`: regenerates synthetic fixture assets when needed

When possible, use real project behavior with small fixtures instead of excessive mocking.

## Test Strategy

Prefer a mix of:

- unit tests for helper modules
- branch-focused tests for install/rebuild/zip/beta flows
- fixture-based integration tests for archive and world registration behavior

Good targets for future tests:

- install edge cases in `bedrock_pack_installer/install.py`
- dispatch and error paths in `bedrock_pack_installer/commands.py`
- world selection and world JSON handling in `bedrock_pack_installer/worlds.py`
- logger and CLI integration

Avoid brittle tests that only assert colored terminal formatting unless the formatting itself is the feature under test.

## Dependencies

Project config lives in `pyproject.toml`.

Keep:

- runtime dependencies in `[project.dependencies]`
- test dependencies in `[project.optional-dependencies].test`

`requirements.txt` still exists for convenience, so if dependencies change, keep it in sync with the current practical workflow.

## Code Style

General expectations:

- keep modules small and focused
- prefer straightforward file/path operations over clever abstractions
- preserve the current package structure unless there is a clear benefit to changing it
- keep terminal output concise and readable
- avoid reintroducing large ASCII divider formatting

When adding functionality:

- prefer extending existing modules over adding one-file abstractions with no clear ownership
- add tests alongside behavior changes
- update `README.md` if user-facing behavior changes

## Git And Commits

Use conventional commits.

Examples:

- `feat: add dry-run install mode`
- `fix: restore missing pack files when json exists`
- `test: add archive fixture coverage`
- `docs: update runtime layout`

Commit message format:

```bash
git commit -m "feat: short summary" \
  -m "- bullet one" \
  -m "- bullet two" \
  -m "- bullet three"
```

Rules:

- subject line should be short and imperative
- body should be a flat bullet list
- do not write a paragraph body when a bullet list is requested
- keep commits scoped to one logical change when possible

## Before Finishing Work

For normal code changes:

1. Run `pytest`
2. Check coverage if the change affects untested branches
3. Update fixtures/tests/docs if behavior changed

If you cannot run tests, state that explicitly and explain why.
