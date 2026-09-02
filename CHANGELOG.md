# Changelog

## 0.29.1

### Changed

- `tsk_0100d8e5` — the local loop now runs the CURRENT platform runtime. The
  copy the CLI carried had frozen several months behind, so `somewhere dev` was
  quietly running your `api/` functions against an older `sw.*` than your
  deployed ones. Re-synced deliberately, with a hash guard so it cannot drift
  silently again. What this changes for you is below.
- `tsk_0100d8e5` — the structured database API works locally: `sw.db.from`,
  `.insert`, `.update`, `.delete`, `.count`. Tables need a scope declaration for
  the platform to scope them to the signed-in user; an undeclared table returns
  a clear error naming the table.
- `tsk_0100d8e5` — also newly available in the local loop: sign-in with GitHub
  and Discord, roles and moderation (`sw.auth.requireRole`,
  `sw.auth.moderation.*`), plans and entitlements (`sw.billing`), scheduling
  (`sw.calendar`), contacts, and durable agents (`sw.agent`). Email gains
  delivery `status` and `history`, payments gains `quote` and a per-user billing
  portal, and search gains `add`.
- `tsk_0312cf17` — `somewhere dev` now builds with the same React version the
  deploy image builds with. It previously installed the lowest version your
  range allowed (`^19.2.0` became 19.2.0) while deploy used 19.2.7, so the loop
  and production could differ by a patch release you would only discover in
  production.
- `tsk_106f7ab1` — one vocabulary for previews across the CLI. Commands and
  messages say **preview** and **production**; `somewhere promote` names its
  arguments `preview_session_id` and `preview_id`. `--draft` still works as an
  alias of `--preview`, so nothing you already type breaks.

### Fixed

- `tsk_8a9d2d1a` — `somewhere deploy` no longer tells you "Next.js apps don't
  run here" when your app is not a Next.js app. Any project with a `src/pages/`
  folder tripped it — including the app `somewhere init` creates, so this was
  often the first thing a new project printed. A Next.js app is now identified
  the way the platform identifies one: a `next` dependency or a `next.config`
  file.
- `tsk_cf48f4ab` — `somewhere dev --cloud` on a plan without private previews
  now refuses before doing anything, instead of publishing a first production
  version and only then telling you the command is unavailable. Nothing is
  created.

### Known difference

- The JavaScript bundle `somewhere dev` builds and the one `somewhere deploy`
  builds are the same code, built by the same compiler with the same dependency
  versions — but they are not byte-identical. Build comments and source-map
  entries record where each module was read from, which is your machine locally
  and the build image on deploy. It has no effect on what your app does.

## 0.29.0

### Added

- `tsk_95377909` — `somewhere dev` is now a LOCAL loop. It serves your app on
  localhost and compiles it with the platform's own compiler — the same
  `compile-core` the deploy pipeline runs, vendored into the CLI at the exact
  esbuild version the compile container pins, with a hash manifest and a test
  that fails if anyone edits it. No install step, no build step, no deploy:
  a fresh `somewhere init` scaffold starts in a couple of seconds and a saved
  TSX or CSS edit is on the page in a few hundred milliseconds. Compile errors
  print file:line:column in the terminal and show on the page with the last
  working page still underneath; `api/` functions run in local Node with
  `sw.db` / `sw.fs` / `sw.ai` / `sw.auth` calling your real project.
  There is no dev version of your app — same app, same data, same build.
  Functions execute in your machine's Node during the loop rather than on the
  platform's runtime, so a deploy is still what proves a function in production.
- `tsk_737ff0d2` — the local server now answers on both `127.0.0.1` and `::1`,
  so the `http://localhost:...` URL it prints opens in a browser that resolves
  `localhost` to IPv6 first. Non-loopback addresses are still refused.
- `tsk_3269026d` — `api/` functions resolve npm packages through the same
  search path the compiler used, so a fresh scaffold's routes work with no
  `npm install`. The project's own `node_modules` always wins.
- `tsk_8796c588` — the pre-start typecheck is skipped, with one line saying
  why, when the project has no `node_modules` — instead of reporting dozens of
  unresolvable-type errors about code you did not write.

### Changed

- `tsk_95377909` — the cloud preview watcher, which used to be bare
  `somewhere dev`, is now `somewhere dev --cloud`. `--local` is still accepted
  and does what bare `somewhere dev` does. `somewhere dev <cmd...>` still runs
  your own command with the project's environment variables injected.

### Fixed

- `tsk_8a3f6540` — `somewhere dev --cloud` on a project that has never been
  published now publishes the first version once, announced in plain words,
  instead of failing the initial sync. A private preview is a candidate built
  against your live version, so there was previously nothing for the first one
  to build on.
- `tsk_e929774b` — the `--json` contract test no longer deploys to the live
  platform on every `npm test`. It ran logged out with no API URL, so
  `deploy`, `deploy-check` and `browser` reached production and minted a real
  temporary account and a real project per run — while asserting nothing about
  what those deploys did. The shape contract now runs against the local stub,
  and the one test that does deploy for real
  (`test/deploy-outcome-live.test.mjs`) uses an explicitly created throwaway,
  asserts the deploy outcome and what the live URL serves, purges the
  throwaway and confirms it is gone, and skips with a named reason when there
  is no signed-in credential.

## 0.24.0

### Security

- `tsk_f7ba3b57` — credential-at-rest hardening. Config is now written atomically at `0600` (a pre-existing world-readable `~/.somewhere/config.json` is tightened on every write, not just on create). `logout` now revokes the session server-side (best-effort) in addition to removing the local token.

### Breaking

- `tsk_f7ba3b57` — `auth set <token>` no longer accepts the token as a positional argument (it was visible in the process table to other local users). Provide the token via the `SOMEWHERE_TOKEN` environment variable or stdin: `printf %s "$TOKEN" | somewhere auth set`.

## 0.23.1

### Fixed

- `tsk_e67bcc16` — made JSON mode a CLI-wide success/error contract, added JSON output to `docs`, `api`, and `init`, and covered every registered `--json` command with a parseability test.
- `tsk_c6035afa` — duplicate of `tsk_06c1f77a`; rollback failures now remain structured JSON in JSON mode.
- `tsk_41ee402b` — replaced the stale-era rollback snapshot wording with current recovery guidance; restoring the previous promoted release still requires the platform follow-up noted below.
- `tsk_971775dc` — `logs --follow` now keeps polling after an empty initial query and suppresses overlapping records.
- `tsk_8dc77749` — deploy requests now have an abortable long-call deadline, progress heartbeat, and one bounded retry instead of waiting without a terminal result.
- `tsk_05a3cf11` — fixed the no-`node_modules` typecheck fallback to run `npx -y -p typescript tsc`.
- `tsk_451eb155` — added non-interactive `init --link --project <ref>` with exact ID/name/slug/subdomain matching and JSON output.
- `tsk_1584392a` — duplicate of `tsk_43fe9ff0`; corrected direct-run documentation for the multi-bin npm package.
- `tsk_0160bfd4` — retained and regression-tested log-ID deduplication across follow polling cycles.
- `tsk_208f7583` — replaced the confusing fresh-project rollback snapshot wording; the snapshot-selection platform follow-up is noted below.
- `tsk_06c1f77a` — rollback API and network failures emit parseable JSON error envelopes.
- `tsk_e6293ee2` — deploy warnings already present in the build log are no longer printed a second time.
- `tsk_43fe9ff0` — documented the correct multi-bin invocation: `npx -y -p @somewhere-tech/cli@latest somewhere <command>` (or the equivalent `npm exec --package ... -- somewhere`).
- `tsk_b210d436` — bare `somewhere docs` now streams the full reference; the topic menu remains available at `somewhere docs --list`.
- `tsk_873f694c` — retained and regression-tested the real two-step project deletion confirmation flow and truthful server errors.

### Platform follow-up

- `tsk_41ee402b`, `tsk_208f7583` — rollback must select and restore the previous live/promoted release snapshot, not an intermediate deploy version, and every fresh deploy/promote path must persist the restorable snapshot before changing the live pointer.
