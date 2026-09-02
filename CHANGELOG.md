# Changelog

## 0.30.1

### Added

- `tsk_0e9e13b8` — `somewhere signup` exists. Someone who has never used the
  platform ran `somewhere login`, and the CLI's answer assumed they already had
  an account. `signup` prints the page that creates one, and `login` names it
  too, so the front door is a door.
- `tsk_c166924f` — `somewhere deploy` publishes your **app**, not the folder it
  was built in. Notes, task lists, scratch files and agent instructions in your
  project root stay on your machine: the deploy prints `Not published (N): …`
  naming exactly what it held back, so the decision is visible rather than
  silent. Publish one on purpose with `somewhere deploy --include <file>`, or
  keep it permanently with a `!<file>` line in `.somewhereignore`.

### Fixed

- `tsk_926fbf8e` — `somewhere docs <topic>` answers from the public corpus with
  no login. Reading the documentation used to require an account, which is the
  wrong order: you read the docs to decide whether to make one.
- `tsk_f250e561` — `somewhere status` exits 0 when the platform answers a plan
  question. A feature your plan does not include is an ANSWER, not a failure;
  exiting non-zero made every scripted `status` on a Free account look like a
  broken command.
- `tsk_a605ff7b`, `tsk_10be456b` — `somewhere browser` against a local URL now
  fails inside a bound instead of hanging. Every wait on the local path has a
  deadline, a port with nothing listening is reported as such with the remedy
  named, and the browser's own favicon request — which the page never made — no
  longer counts as your app returning a 404.
- `tsk_9c5ed7f8` — a failed `somewhere deploy` now says something you can act
  on. When the platform answers `retry: true` — its own statement that the
  request changed nothing and the same one is safe to send again — the CLI
  retries once instead of stopping (it parsed that field and never read it).
  An error body it cannot classify prints the status and the response instead
  of the bare words "Unknown error". And every deploy failure now prints the
  request id from the response, so a failure you can see is a failure we can
  find.
- `tsk_eef0a0ef` — `somewhere dev` prints your app's output, not the platform's
  telemetry. Database calls were emitting raw internal metrics JSON and a
  repeated "deferred flush failed: HTTP 403" from a background channel you did
  not ask for and cannot fix. Both are gone by default; set
  `SOMEWHERE_DEV_TELEMETRY=1` to see them.
- `tsk_a8cb3d23` — the local loop resolves a dependency at the version the build
  image serves, for every package the image carries. This already held for
  React; it now holds for the whole baked set (router, query, state, forms,
  validation, http, dates, utils, styling, animation, charts, icons), so a
  declared `^3.23.0` no longer compiles against 3.23.0 on your machine and a
  newer one on deploy. A pin is taken only when the image's version satisfies
  the range you declared — a project on a major the image does not carry is
  untouched.

### Known difference

- The JavaScript bundle `somewhere dev` builds and the one `somewhere deploy`
  builds are built by the same compiler, from the same source, with the same
  toolchain. They are not byte-identical, and there are two reasons rather than
  one. Build comments and source-map entries record where each module was read
  from — your machine locally, the build image on deploy — which has no effect
  on what your app does. Separately, the two builds can still resolve DIFFERENT
  VERSIONS of an app dependency: `somewhere dev` uses the tree you installed,
  while `somewhere deploy` resolves the range your `package.json` declares and
  does not yet read your lockfile. If that matters to a library you depend on,
  pin it exactly in `package.json` and both sides agree.

## 0.30.0

### Added

- `tsk_9ec50c84` — `somewhere browser` now drives a **localhost** target. The
  app `somewhere dev` is serving used to be the one address this CLI's own
  browser would not visit, so every visual and DOM check had to wait for a
  production deploy. A loopback URL is now driven by the browser already
  installed on your machine — no new dependency and nothing to download. Each
  run gets an empty throwaway profile, so it never reads or writes your real
  browser profile. If there is no browser at all, the CLI says so and names the
  environment variable to point at one. Flags only the hosted browser can honour
  (`--store`, `--session`, `--extract`, non-`dom` `--include`) are refused by
  name rather than silently dropped from a report that still looks complete.
- `tsk_70fd0f63` — `somewhere errors` gained a `kind` column and an
  `--exceptions` flag, so you can see only what actually broke.

### Fixed

- `tsk_bdd72f02` — `somewhere browser --snapshot` now asks for the map it
  prints. `--snapshot` renders the interactive-element outline, but it never
  requested that section, so it printed whatever the response happened to carry
  — usually nothing. `browser --wait button --snapshot` would match a button and
  then report "dom: 0 interactive elements" on a page with three buttons and two
  inputs. It now adds `dom` to the requested sections, merging with an explicit
  `--include` rather than replacing it. The local outline comes from the
  platform's own probe, so it is a preview of the hosted answer rather than a
  second opinion.
- `tsk_ea4274ca` — `somewhere errors` no longer calls a working auth gate an
  exception. If you probed your own endpoint signed out — deliberately, to prove
  the gate holds — your 401 was listed as the only exception in 24 hours. Rows
  now show their kind: **refused** for a 4xx your handler returned on purpose,
  **exception** for an uncaught throw or a 5xx, with the summary line splitting
  the counts. Nothing is hidden by default.
- `tsk_ea4274ca` — a stored screenshot printed as a storage path, which reads as
  a URL and is not one, so the one value the command handed back for "here is
  your screenshot" could not be used to see it. The report now leads with the
  link that opens it and keeps the stored path on its own line, because that is
  the handle for reading or replacing the file later.
- `tsk_53badecf` — `somewhere dev --check` and `somewhere deploy` no longer
  report the `somewhere/db` import from our own managed-schema documentation as
  a missing npm package whose remedy is installing an unrelated package. The
  specifiers the platform provides are now treated as provided. A genuinely
  missing package still warns, and still names every file that imports it.
- `tsk_a21bc829` — `somewhere dev` no longer asks you for a variable the
  platform writes. It warned that `APP_URL` had no local value on projects whose
  source never mentions `APP_URL` — it never would, because deploy writes that
  key. The local loop now fills it with the local origin, or with the project's
  public URL when nothing is being served locally. Keys you genuinely own are
  still named, which is the point of that warning.
- `tsk_6a2a09bc` / `tsk_320a0bc6` — the local loop now declares tables the way
  deploy declares them. It kept only the owner column and dropped the intent, so
  `sw.db.from` on a `shared()` table answered "this table has no declared
  intent" locally while working fine on the same deployed project. Intents,
  owner scopes and the owner-identity mode now cross over exactly as the deploy
  bundle bakes them.
- `tsk_4df056ea` — when your plan does not include reaching the project database
  from the local loop, `somewhere dev` now says so **once, at startup**, before
  you write a line of code. It previously started a clean serving loop and let
  you discover at the first request that every `sw.db` call was refused — with a
  message that called it a connection problem and suggested redeploying, which
  could never help. The loop still runs: the frontend compiles and serves, hot
  reload works, and every function that does not touch the database still runs.
  Deploying is unaffected on every plan, and the deployed app reads and writes
  its database normally. `somewhere status` reports the same answer, including a
  `local_dev_db` object in `--json`.
- `tsk_a21bc829` — `--check`'s help now says what the documentation says: it
  needs a real `npm install`, because the typechecker reads package types out of
  `node_modules` and the CLI's dependency cache does not stand in for that.

### Changed

- The vendored platform runtime and compiler are re-synced to the current
  platform. For the local loop this brings `owner()` scoping on visitor-mode
  projects, exact 64-bit integer fidelity on structured writes and batches, and
  the plan-derived local-database answer above.


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
  builds are the same code, built by the same compiler — but they are not
  byte-identical. Build comments and source-map entries record where each module
  was read from, which is your machine locally and the build image on deploy.
  It has no effect on what your app does.

  **Correction (0.30.1):** this entry also said the two builds use the same
  dependency versions. That was not true — they can resolve different versions
  of a dependency whose range you left open. See the Known difference under
  0.30.1 for what actually holds and what to do about it.

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
