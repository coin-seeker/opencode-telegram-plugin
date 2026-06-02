# AGENTS.md

Conventions for working in this repository.

## Layout
- `plugin/` is the publishable npm package (`@coinseeker/opencode-telegram-plugin`). The repo root is a private workspace wrapper.
- Source in `plugin/src/`; built output (committed) in `plugin/dist/`; tests are `*.test.ts` beside the source (`node:test` via `tsx`).
- Manual QA harnesses live in `plugin/qa/` and are excluded from the published package.

## Commands (run from `plugin/`)
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — `tsx --test "src/**/*.test.ts"`
- `npm run build` — typecheck + `tsup` bundle into `dist/`
- `npx biome check --write <files>` — format/lint

## Release
- Bump `plugin/package.json`, and sync the version pins in `README.md`, `plugin/README.md`, and `docs/installation.md`.
- `cd plugin && npm publish` (runs typecheck + tests via `prepublishOnly`, build via `prepack`).

## Git
- **Push over SSH.** `origin` must be `git@github.com:coin-seeker/opencode-telegram-plugin.git`.
- Do NOT use an HTTPS remote here: this is a public repo, and the maintainer's fine-grained HTTPS PAT only carries the automatic read-only access GitHub grants PATs on public repos, so HTTPS `git push` returns `403`. SSH uses the local key and works.
- If `origin` ever shows an `https://` URL, switch it back:
  `git remote set-url origin git@github.com:coin-seeker/opencode-telegram-plugin.git`
