# Changelog

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
