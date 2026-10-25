# AGENTS.md

## Project Purpose

This project installs and manages Minecraft Bedrock packs (`.mcaddon`, `.mcpack`, `.zip`, or extracted folders) on a server reached through a local folder, SFTP, FTP, or FTPS.
It is a Node.js + TypeScript app: a Fastify server with a React web UI, shipped as a single executable (Node SEA). There is no CLI beyond the startup options.

## Structure

- `src/shared/`: the contract between server and UI. `model.ts` (packs, worlds, plans, connection settings), `api.ts` (routes, request/response types, token header), `events.ts` (job events)
- `src/server/main.ts`: startup options (`--port`, `--no-browser`, `--data-dir`, `--dev`), server start, browser launch
- `src/server/http/`: `app.ts` (routes, uploads, SSE, static files), `session.ts` (connection and target state)
- `src/server/jobs/runner.ts`: one job at a time, AbortController cancel, event buffer with `since` replay, `JobFailure` codes
- `src/server/storage/`: `storage.ts` (base class: listing cache, concurrency limit, atomic writes, uploadTree/removeTree/scanTree), `local.ts`, `sftp.ts`, `ftp.ts`, `knownHosts.ts`, `connect.ts`, `path.ts`, `errors.ts`
- `src/server/core/`: `manifests.ts`, `layout.ts` (layout detection and `Target`), `builtins.ts`, `packIndex.ts`, `worlds.ts`, `nbt.ts`, `log.ts`
- `src/server/core/install/`: `unpack.ts`, `plan.ts`, `index.ts`
- `src/server/core/commands/`: `status.ts` (world status, `otherWorldsUsing`), `uninstall.ts`, `maintenance.ts` (audit, rebuild, cleanup, fix nesting), `worldPacks.ts` (register, reorder, subpack), `worldEdit.ts`, `backup.ts`
- `src/server/app/`: `paths.ts` (run folder), `profiles.ts`, `logs.ts`
- `src/web/`: React UI. `api/client.ts`, `state/app.tsx` (runs and follows jobs, reattaches after a reload), `components/*.tsx`, `styles/app.css`
- `scripts/`: `build-server.mjs` (esbuild bundle), `build-sea.mjs`, `bench.ts`, `demo-servers.ts`, git hook installers

Change `src/shared/` first when the API changes, then the server and the UI against it.

## Runtime Layout

Do not put runtime data in the repo root. Everything the app writes goes under `run/` (next to the exe when packaged, the current folder otherwise, or `--data-dir`):

- `run/logs/`: `latest.txt` plus the 5 most recent timestamped logs
- `run/staging/uploads/` and `run/staging/unpack/`
- `run/known_hosts`
- `run/profiles.json`

Add new paths to `src/server/app/paths.ts` and `ensureDirs`.

## Security Rules

- Bind to `127.0.0.1` only. Keep the per-launch token, Host and Origin checks, and CSP. Decide "is this the API" from the matched route and the decoded path, never the raw URL.
- Never save or log passwords.
- Never accept an SFTP host key silently: unknown keys go back to the user as `unknown_host_key`; changed keys are refused.
- Upload paths go through `safeRelative`; archive extraction must reject zip-slip paths and stay within `ARCHIVE_LIMITS`.
- Commands only act on worlds from the session's world list (`Session.requireWorld`).
- Never delete built-in packs, dev pack folders, or pack folders another world still uses. Check through `otherWorldsUsing` (pass the `PackIndex`), and treat a world whose pack list cannot be read as using the pack.
- Tree operations never follow symlinks (`Entry.link`).

## Speed

Remote servers are latency-bound, so:

- run bulk work through `Storage.map()` / the storage concurrency limit, not unbounded `Promise.all`
- reuse the per-job listing cache instead of listing the same folder twice
- prefer one scan (`PackIndex`) per job and reuse it for status after a change
- check `npm run bench` when touching storage or install code

## UI

- Keep the dashboard layout from the approved mockup: sidebar (worlds, layout, hidden packs), tabs, filter chips, plan panel, docked console.
- Follow the `react-hooks` lint rules: derive state or remount with a `key` instead of setting state synchronously in effects.
- Keep terminal-style colours in the console; job logs are structured events, not ANSI.

## Testing

```bash
npm test
npm run test:e2e
```

- Vitest covers storage contract tests against local, in-process SFTP (`tests/servers/sftpServer.ts`) and FTP (`tests/servers/ftpServer.ts`), core and install tests, API tests via Fastify `inject`, and component tests.
- Use fixtures under `tests/fixtures/` and helpers in `tests/helpers.ts`. If fixture contents change, update `tests/fixtures.test.ts`.
- Prefer real behaviour against small fixtures and the in-process servers over mocking.
- Run `npx playwright install chromium` once before the Playwright tests.

## Linting

```bash
npm run lint
npm run typecheck
npm run format
```

ESLint (typescript-eslint, react-hooks) and Prettier (print width 140) configs live in the repo root.

## Dependencies

- runtime dependencies in `dependencies`; everything bundled for the UI or used for build and tests in `devDependencies`
- use `npm ci` in CI and keep `package-lock.json` committed
- the server bundle is CommonJS (`dist/server.cjs`) for SEA; keep esbuild `mainFields: ["module", "main"]`

## Code Style

- TypeScript strict, ESM, small focused modules
- prefer straightforward storage/path operations over clever abstractions
- add tests alongside behaviour changes
- update `README.md` if user-facing behaviour changes

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
- keep commits scoped to one logical change when possible

## Before Finishing Work

1. `npm run lint`
2. `npm run typecheck`
3. `npm test`
4. `npm run test:e2e` if the UI or HTTP API changed
5. Update tests and docs if behaviour changed

If you cannot run something, say so and explain why.
