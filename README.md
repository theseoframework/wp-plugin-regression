# WordPress plugin regression via Playground

This package boots a local WordPress Playground site, mounts a plugin, captures front-end output, and compares before and after states.

## Installation

1. Import this Git's files to a private folder location.
1. Open Terminal.
1. `cd` to folder.
1. Enter: `npm install`.

## Updating

1. Open Terminal.
1. `cd` to folder.
1. Enter: `git pull`.
1. Enter: `npm install`.

## Usage

1. Open Terminal.
1. `cd` to folder.
1. Enter: `node run.js <command> --root <consumer> --plugin-json <plugin.json>`.

Commands:

```
node run.js launch --root C:\path\to\plugin --plugin-json C:\path\to\plugin.json
node run.js stop --root C:\path\to\plugin
node run.js capture --root C:\path\to\plugin --plugin-json C:\path\to\plugin.json --label before
node run.js compare --root C:\path\to\plugin --plugin-json C:\path\to\plugin.json --before before --after after
node run.js harness --root C:\path\to\plugin --action ping
node run.js harness --root C:\path\to\plugin --json-file C:\path\to\payload.json
node run.js surfaces --root C:\path\to\plugin --plugin-json C:\path\to\plugin.json
```

Optional launch flags: `--wp`, `--php`, `--site`, `--plugin=working|wporg`, `--port`, `--pair`, `--keep`.

`--wp` is a Playground build slug (`latest`, `beta`, `trunk` / `nightly`, `7.0`, `6.9.1`, `6.8-RC1`, or a zip URL), not a path to Core. `resolveWordPressRelease()` turns that slug into `{ version, releaseUrl }` (for example `latest` → `7.1` and the zip URL). Playground caches the zip as `~/.wordpress-playground/<version>.zip`. The engine unpacks a slim copy at `~/.wordpress-playground/wp/<version>/` (same version token), keeps `WP_DEFAULT_THEME`, and mounts it with `install-from-existing-files`. Official Core zips still ship several Twenty* themes; there is no one-theme bundle.

Site persist is not in the consumer repo. It lives at `~/.wordpress-playground/tests/<plugin.slug>/<version>/<site>/`. Launch wipes that folder unless you pass `--keep`. Live runs are listed in `~/.wordpress-playground/tests/runs.json`. `stop` with no `--port` stops every run for `--root`. `trunk` is the prebuilt WordPress/WordPress nightly. It is not a local `wordpress-develop` tree. `--wp=7.2` only works if Playground hosts that release. PHP is `--php` (`7.4`–`8.5`).

A/B is two capture labels and `compare --before <prev> --after <cur>`. For a live side-by-side, `launch --pair` starts wordpress.org on `http://127.0.0.1:9001` (`--site=before`) and the working tree on `http://127.0.0.1:9002` (`--site=after`). `capture --label before` / `--label after` pick those sites. `compare` still diffs the JSON bundles. A single `launch` stays on port `9400`. Override pair ports with `--port-before` / `--port-after`. Do not reuse one persist folder across `--wp` versions.

This engine does not drive a browser. Logged-out HTTP capture covers front-end artifacts. Admin UI and REST-from-the-browser A/B is a Playwright MCP consumer of the live site URL after `launch`.

`plugin.json` may list `entries` (id, type, path, optional frame), `surfaces` (feature → page types), `surfaceLines` (feature → substrings), and `headTags` (regexes). `capture` writes one `captures/<label>.json` bundle. HTML captures store the plugin head-marker block, then prepend `headTags` matches from `<head>` that are not already in that block. Those extras are ambiguous (theme, core, or the plugin). `capture` / `compare` accept `--feature=<name>` or `--types=post,page` and print that feature’s page list first. `compare --feature` then diffs only matching lines (plus status/location). `surfaces` prints the whole map.

`--root` is the consumer repo (where `.local/playground` is written). Optional `dir` is a package folder relative to `--root`; mounts resolve from there. `activate` (default true) controls the blueprint `activatePlugin` step. `extraPlugins` is more `{ slug, dir, mainFile, mounts, activate }` entries mounted and optionally activated the same way. `extraMounts` is `[ hostRel, vfs ]` directory pairs resolved from `--root` (trees that must not land under `wp-content/plugins/`). When `vfs` is under `/wordpress/wp-content/`, the engine also hardlinks that tree into the persisted site so a parent `wp-content` mount cannot hide the files. Omit these fields for a single-plugin repo whose `--root` is the plugin itself.

`harness` action `frame` asks the consumer to switch a reading frame (for example blog-on-front vs a static front page).

Captures are logged-out. The server is not started with `--login`. Same-path redirects are followed; a redirect to a different path is recorded as-is.

`capture` also accepts `--path` / `--paths` (comma-separated) and appends those URLs to the bundle.

Harness `post` and `term` accept `slug`, `meta` (object), and optional `id` to update. Replies include `url` and `path`. `meta` writes one key (`type` is `post` or `term`). Consumer shims may handle plugin-specific meta via `wp_plugin_regression_update_meta`.

Pretty permalinks are set in the blueprint, but rewrite rules are not flushed there. Playground must flush them on a later `init` after post types exist. A `flush_rewrite_rules()` during boot writes incomplete rules and makes post permalinks and 404s fall through to the homepage.

Workaround until [WordPress/wordpress-playground#4325](https://github.com/WordPress/wordpress-playground/issues/4325) is patched: Playground ships a mu-plugin that 301s `/sitemap.xml` to `/wp-sitemap.xml`. Launch overwrites that file with a valid PHP no-op so the mounted plugin can own the endpoint. Drop the overwrite when that issue lands. Do not write `'<?php\n'` in a single-quoted PHP string; that is a parse error and every request 500s.

Captures stay under the consumer `.local/playground/captures/`. Sites, slim Core trees, wporg zips, and `runs.json` stay under `~/.wordpress-playground/`.

## Issues

Node.js 20.18 or higher must be on your PATH.

`stop` sends a graceful tree kill first, then force, and waits until the site SQLite file is unlocked. If a hard kill still leaves that file unreadable, retry stop, then launch (default is a fresh wipe).

PowerShell strips quotes from `--json "{...}"`. Use `--json-file <path>` (resolved from `--root` when relative).
