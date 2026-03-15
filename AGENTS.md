# AGENTS.md

## Project Purpose

This project installs Minecraft Bedrock packs into a world from `.mcaddon`, `.mcpack`, `.zip`, or already-extracted folders.

The current architecture is a small Python package with a thin top-level script:

- `bedrock_pack_manager.py`: entrypoint
- `bedrock_pack_manager/cli.py`: CLI parsing and startup
- `bedrock_pack_manager/install.py`: install flow
- `bedrock_pack_manager/commands.py`: install, uninstall, rebuild, zip, audit, and world-edit commands
- `bedrock_pack_manager/worlds.py`: world JSON helpers and selection
- `bedrock_pack_manager/manifests.py`: manifest parsing and classification
- `bedrock_pack_manager/nbt.py`: `level.dat` beta and gamemode helpers
- `bedrock_pack_manager/logger.py`: run log capture
- `bedrock_pack_manager/paths.py`: runtime path layout
- `bedrock_pack_manager/console.py`: console output helpers

## Runtime Layout

Do not put runtime data in the repo root.

All runtime data belongs under `run/`:

- `run/install/`
- `run/installed/`
- `run/uninstall/`
- `run/uninstalled/`
- `run/behavior_packs/`
- `run/resource_packs/`
- `run/worlds/`
- `run/logs/`

If you add any new operational output, cache, report, or temp artifact, place it under `run/` unless there is a strong reason not to.
Startup currently creates the full runtime tree before logging, world selection, install, or uninstall logic runs.

## CLI Conventions

Use `argparse` in `bedrock_pack_manager/cli.py`.

Current public commands:

- default install: `python bedrock_pack_manager.py`
- rebuild: `python bedrock_pack_manager.py --rebuild`
- cleanup pack folders: `python bedrock_pack_manager.py --cleanup-pack-folders`
- zip: `python bedrock_pack_manager.py --zip`
- audit: `python bedrock_pack_manager.py --doctor`
- uninstall: `python bedrock_pack_manager.py --uninstall`
- beta toggle: `python bedrock_pack_manager.py --beta`
- gamemode set: `python bedrock_pack_manager.py --gamemode creative`

Current public selection and install modifiers:

- duplicate handling: `--duplicate-mode skip|replace|keep-both`
- world selection: `--world-name <name>` or `--world-path <path>`
- uninstall keep files: `--uninstall-keep-files`
- zip name: `--zip-name world.zip`

When adding CLI options:

- keep `python bedrock_pack_manager.py --help` accurate
- prefer explicit flags over implicit behavior
- preserve existing workflows unless the user asked for a breaking change
- keep CLI flags and the interactive prompt/menu in sync
- if you add a CLI action or option, add the corresponding interactive prompt path when it makes sense for interactive use
- if you add or change an interactive action or option, add or update the corresponding CLI flag or argument unless the user explicitly wants it to stay interactive-only

## Logging

Run logs are captured automatically through `bedrock_pack_manager/logger.py`.

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

CI currently runs in GitHub Actions with `.github/workflows/quality-checks.yml` for Ruff and pytest, plus `.github/workflows/build-artifacts.yml` for Linux and Windows one-file builds.
Local Git hooks can be installed with `make install-hooks` on POSIX or `scripts/install_git_hooks.ps1` on Windows; they run Ruff on `pre-commit` and pytest on `pre-push` using the local `.venv`.

## Linting

Primary command:

```bash
make lint
```

Auto-fix command:

```bash
make lint-fix
```

Rules:

- use Ruff as the project linter
- keep lint configuration in `pyproject.toml`
- keep the current Ruff line length at `180` unless there is a project-level reason to change it
- if lint dependencies change, keep `requirements.txt` in sync
- if `make lint` or `make lint-fix` depends on tooling, keep the local `.venv` workflow accurate in docs

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

- install edge cases in `bedrock_pack_manager/install.py`
- dispatch and error paths in `bedrock_pack_manager/commands.py`
- world selection and world JSON handling in `bedrock_pack_manager/worlds.py`
- logger and CLI integration

Avoid brittle tests that only assert colored terminal formatting unless the formatting itself is the feature under test.

## Dependencies

Project config lives in `pyproject.toml`.

Keep:

- runtime dependencies in `[project.dependencies]`
- lint dependencies in `[project.optional-dependencies].lint`
- test dependencies in `[project.optional-dependencies].test`

`requirements.txt` still exists for convenience, so if dependencies change, keep it in sync with the current practical workflow.
The current convenience file includes runtime, test, and lint tooling.

Development workflow should assume a local `.venv` when documenting setup, testing, linting, or build steps.
Before running project Python tools directly in the shell, activate the local virtual environment with:

```bash
. .venv/bin/activate
```

Prefer commands run from the activated `.venv` over the system Python environment.

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
2. Run `make lint`
3. Check coverage if the change affects untested branches
4. Update fixtures/tests/docs if behavior changed

If you cannot run tests, state that explicitly and explain why.
