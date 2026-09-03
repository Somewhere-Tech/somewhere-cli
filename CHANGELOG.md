# Changelog

## 0.31.7

### Added

- **`somewhere init` now starts with a working full-stack TypeScript app.** In
  an empty directory, the default starter includes a typed React page, a typed
  server function, and a database schema, with exact dependency versions
  installed before init reports success. Use `--bare` for the previous
  metadata-only setup; existing source directories are still left untouched.

### Fixed

- **Project deletion now follows the platform's two-step confirmation flow.**
  The CLI recognizes the successful `needs_confirmation` response as well as
  the older error-shaped response. At a terminal it asks for the project name;
  without a terminal it prints the exact `--confirm-code` command to run next.
  Unrelated server errors continue to surface unchanged.
- **A slow package verdict no longer turns into a failed install.** Verdict
  lookups have a more realistic cold-start allowance. If that allowance is
  exhausted, `somewhere npm install` says `verdict pending` and continues with
  npm under the default fail-open policy.

## 0.31.6

### Added

- **Device login now shows what is asking for access.** The approval page can
  show the machine name, CLI and runtime versions, operating system, and the
  requested project scope before access is allowed or denied. After approval,
  `somewhere login` prints that scope, `somewhere whoami` names the current
  session and its access, and `somewhere logout` revokes the session on the
  server before removing the local credential.
- **`somewhere browser` can drive routine flows without custom JavaScript.**
  Repeatable `--fill`, `--select`, `--click`, and `--expect` flags run in command
  order, while `--actions <file.json>` accepts the same shared action sequence
  as the platform browser. `--expect-request <path:status>` treats an intended
  response such as an authorization refusal as expected, and `--visible-only`
  removes hidden controls from the page outline. Localhost session help now
  says plainly that named sessions are unavailable there and points to a fresh
  local browser run.
- **`somewhere db apply-schema` prepares a managed database before the first
  deploy.** It reads `db/schema.ts` by default, applies the declaration to the
  production database without publishing the app, reports an already-current
  schema as a no-op, and preserves the planner's exact safety message when a
  removal needs an explicit `removed()` or `removedTable()` marker.

### Fixed

- **Local browser checks no longer stall when the CLI uses an isolated home on
  macOS.** The headless browser still runs with a new scratch profile and no
  extensions, while the CLI's credentials remain inside the isolated home.

## 0.31.5

### Fixed

- **`somewhere dev` now moves past a busy default port automatically.** If
  8787 is already in use, the local loop selects the next free port and prints
  the choice before startup. Passing `--port` remains strict: a busy requested
  port is an error, and the CLI names the process using it when the operating
  system can identify one.
- **Local database requests now explain where their time went.** Each
  database-backed request in the local loop prints the complete database
  round-trip beside the request total and includes the database execution time
  reported by the platform when it is available. Working responses without
  that field keep working and say that the timing was not reported.

## 0.31.4

### Fixed

- **Status now shows which tested preview reached production.** When production
  came from a promotion, `somewhere status` names the exact candidate and shows
  a short content hash, so you can match the live app to the preview you tested.
- **Promotion now uses the platform's own data notice and exact function count.**
  The notice about preview rows is printed exactly as the platform sends it,
  and the release summary says how many functions reached production when that
  count is available. Older platform responses keep working quietly.

## 0.31.3

### Added

- **`somewhere project allowed-origins list` and `… set` now exist.** Allowing
  another web address to call your project from a browser was only possible
  through the generic tool-call escape hatch with a raw project id — so the
  command guidance told you to run was not a command the CLI had. It is now a
  first-class command with the obvious spelling, it shows up in
  `somewhere project --help`, and it takes `--project <ref>` like everything
  else. `set` replaces the whole list (`--clear` empties it) and refuses an
  address the allowlist could never match — a path, a query, a wildcard, a
  trailing slash — before sending it, naming what is wrong. Your project's own
  address and any verified custom domain are always trusted and never need
  listing.

### Fixed

- **The promote command the CLI prints can now be run in the shell that printed
  it.** `somewhere preview` and `somewhere status` printed
  `somewhere promote <session> <preview>`, and `somewhere promote` then refused
  that exact command whenever there was no terminal to confirm with — so in a
  script, an agent, or a piped terminal the CLI handed you a command it would
  reject. The printed command now matches the shell reading it: without a
  terminal you get the runnable form, with `--yes` on it; at a keyboard you get
  the ordinary confirming form first and the unattended one named beneath it.
- **Promotion now says what happened to your data.** Promoting moved your app
  and said nothing about the rows you created while previewing, which stay in
  the preview database — the isolation is the point, but discovering it by
  opening an empty production page and repeating your whole acceptance pass is
  not. A successful promote now states that only the app was promoted, that
  production is serving the data it already had, and that production is worth
  checking and seeding before you call it shipped.
- **One project now reports one size of itself.** The same directory was
  described three different ways: `somewhere deploy` counted static files and
  functions separately, `somewhere preview` reported a single "3 files" with the
  function hidden inside it, and `somewhere promote` said "3 files + functions",
  replacing the count with the word. Worse, deploy's number did not match what
  the project itself listed. All three now print the same shape — `3 static
  files + 1 function` — off the same counting rule, and promote reports what
  production actually holds rather than a tally that disagreed with it.
- **`--project` works on every command that names a project.** `logs`,
  `errors`, `status`, `open` and `rollback` accepted only a positional project
  and answered `unknown option '--project'`, while a dozen other commands took
  the flag — so the syntax you learned on one command failed on the next. All of
  them now take `--project <ref>`, the positional keeps working everywhere, and
  naming two different projects in one command is refused rather than guessed.

## 0.31.2

### Fixed

- **`somewhere dev` now runs the same entry files `somewhere deploy`
  publishes.** A project whose `index.html` points at
  `<script type="module" src="/src/main.js">` deploys and serves perfectly —
  the platform serves plain JavaScript modules exactly as you wrote them,
  rather than compiling them — but the local loop refused to start on it at
  all, insisting on `.tsx`. It now follows the same rule deploy follows: your
  `index.html` names the entry, `.tsx` / `.ts` / `.jsx` / `.mts` / `.cts` are
  compiled, `.js` / `.mjs` / `.cjs` are served as written, and a page with no
  module script at all (a browser-Babel page, a static site) simply runs. The
  loop stops only when `index.html` names a file that is not in the directory
  — and then it says which file, and which forms it accepts.
- **The local runtime no longer suggests editing a package file outside your
  project.** Running a function could print advice to add `"type": "module"` to
  a `package.json` in a parent directory — on some machines, the one in your
  home folder. The cause was a module-format lookup with no upper bound, which
  walked straight past the project. The runtime now determines the format from
  your project's own package file and your own source, stopping at the project
  root, so no advice can ever name a file outside it. CommonJS and ES module
  functions both keep working exactly as they do when deployed.
- **`somewhere browser --eval` prints the evaluated value in normal output.**
  The value came back correctly with `--json` but was dropped from the default
  text report, so the command you use to check a live page did not show what it
  found. Text output now prints the value under the step — strings as
  themselves, objects readably indented — and an expression that returned
  nothing says so instead of leaving a blank line.
- **`somewhere deploy --temporary` means temporary, whether or not you are
  signed in.** Being signed in used to override the flag and switch the deploy
  to your account, which then failed in a directory with no linked project. The
  flag is the request: it always deploys to a temporary workspace, never needs a
  linked project, and prints the live URL, the claim link, and when the
  workspace expires. Your account sign-in survives it untouched, the directory's
  own link is left alone, and a second `--temporary` deploy in the same window
  redeploys the same temporary app instead of creating another. A deploy without
  the flag is unchanged.

### Changed

- `somewhere init` closes by naming what to run next on the platform —
  `somewhere dev` to run your app here, `somewhere deploy` to publish it — and
  notes that any coding agent can drive this CLI, in place of the previous
  line naming one specific tool.

## 0.31.1

### Fixed

- `tsk_5504e045` — **`somewhere preview` can no longer publish to production on
  its own.** A preview builds on your app's live version, so a project that has
  never been published needs one published first — and that publish is a real
  production release, the one thing this command can do to your live site. It
  was happening in two ways it should not have. On a project that was already
  live, if the CLI could not read which version was live it treated the silence
  as "this project has never been published" and went ahead and published your
  working directory over the running app. And on a project that genuinely had
  never been published, it published without asking at all.

  Now: a version the CLI cannot read is unknown, and unknown never publishes —
  the command stops, says what it could not read, and leaves your live site
  exactly as it was. A publish happens only when the platform positively
  confirms nothing is live AND you say so, either by answering the prompt or by
  running `somewhere preview --publish-first`. A run that cannot be asked — a
  script, an agent, a piped shell — is refused and told about the flag. Preview
  on a project that is already live never publishes anything, as before.
- `tsk_5504e045` — **the plan refusal stopped claiming your project is
  unpublished.** On a Free or Builder account, `somewhere preview` on a live
  project refused with "Nothing was created — this project has not been
  published", which was simply untrue and sent people to re-deploy an app that
  was already running. The refusal now says only what it did: nothing was
  created or changed, and whatever is live stays live.

### Changed

- The dev compiler and function runtime are re-vendored from the platform at
  `3237dc1e`, picking up the faster dependency install — a project with a
  lockfile now installs the way the platform installs it, without development
  dependencies. `somewhere dev` compiles your app with the platform's own
  compiler, so this keeps what you see on localhost identical to what deploy
  produces.

## 0.31.0

### Added

- `tsk_5cfcfe00` — **`somewhere preview` is a command.** There are two loops and
  they are now named after where the app runs: `somewhere dev` runs your app on
  your machine, `somewhere preview` runs it on the platform. Every save goes to
  a private URL reachable only by you; production keeps serving what you last
  promoted until you run `somewhere promote`. Reach for it when you want the
  real hosted app in front of you, or when your agent cannot serve on
  localhost. `dev --cloud` still starts it and prints one line naming the new
  command.

### Fixed

- `tsk_33023348` — **`somewhere promote` never reports an outcome it does not
  know.** It used to print "Promote failed / Unknown error" for a promote that
  had already shipped, and the obvious retry then said "Production was not
  changed" about production that the first command had changed. Promote is the
  one irreversible step in the loop, so it now separates a refusal the platform
  AUTHORED (reported as written) from a response the CLI could not READ. In the
  second case it reads what production is serving before and after and answers
  from whether that moved — and a refusal claiming production was unchanged is
  checked against the same evidence before it is allowed to stand. When neither
  side can be read it says the status is unknown and points at your production
  URL rather than guessing.
- `tsk_74375b3c` — **a promote ends the preview cleanly.** Promoting closed the
  preview, but the loop kept watching, and your next save came back with a
  refusal written for an API client — then failed the same way on every save
  after that. The loop now recognises the end of a preview and stops on it, in
  two lines: what happened, and the one command that starts the next preview.
- `tsk_5cfcfe00` — the preview copy no longer claims your preview has
  production's data. A preview runs against a separate copy of your schema with
  none of your production rows, which is exactly what makes it safe to try
  things in.
- `tsk_d63b3b6a` — **an unresolvable import is reported, not a crash.**
  `somewhere dev` died on any import that could not be resolved — a typo'd
  package, one you had not installed yet — with an internal error naming the
  CLI's own bundler and nothing about your code, and every rebuild after that
  failed too. It only happened when the command's error output went to a file
  rather than a terminal, which is the normal case under an agent, a CI job, or
  a session recorder. Now an unresolved import reads like a syntax error:
  file:line:column, the specifier, and one sentence naming the fix — add it to
  your package.json and install it, or, for a module the platform provides,
  that it comes from the platform and should not be installed at all. The
  server survives, the last working page stays up, and a save that fixes it
  serves again.
- `tsk_14c5408c` — a burst of saves stays one preview update. Saves inside the
  debounce window accumulate into a single update, and a save that lands while
  one is in flight re-arms instead of starting a second, so two previews are
  never building at once.

### Changed

- The vendored platform runtime and compiler are re-synced to the current
  platform build. Content is unchanged from 0.30.2 apart from the provenance
  stamp — the compiler files hash identically — so this release changes no
  build behaviour.

## 0.30.2

### Fixed

- `tsk_a8cb3d23`, `tsk_f79d71ce` — `somewhere dev` and `somewhere deploy` now
  derive dependency versions from the SAME code, so a build on your machine and
  a build on deploy resolve the same libraries. The platform's compiler reads
  your lockfile as of today: a version your lockfile pins is the version that
  gets installed, provided it satisfies the range your `package.json` declares.
  This CLI carries that compiler, so `somewhere dev` follows the identical rule
  — it is one implementation, vendored, not two that agree by coincidence. A
  project with NO lockfile is unchanged: the declared range still floor-pins.

### Known difference

- The JavaScript bundle `somewhere dev` builds and the one `somewhere deploy`
  builds are not byte-identical, and the reason is now only bookkeeping: build
  comments and source-map entries record where each module was read from, which
  is your machine locally and the build image on deploy. It has no effect on
  what your app does.
- The dependencies your project DECLARES resolve the same on both sides. Their
  own transitive dependencies are still resolved by npm from the parents'
  ranges, so those can differ. Pin one exactly in `package.json` if it matters
  to you.

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

  **Superseded by 0.30.2**, which closes the version difference. The paragraph
  above describes 0.30.1 only, and is kept because that version is published.

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
