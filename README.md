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
```

Optional launch flags: `--wp`, `--php`, `--site`, `--plugin=working|wporg`, `--port`.

Captures are logged-out. The server is not started with `--login`. Same-path redirects are followed; a redirect to a different path is recorded as-is.

Pretty permalinks are set in the blueprint, but rewrite rules are not flushed there. Playground must flush them on a later `init` after post types exist. A `flush_rewrite_rules()` during boot writes incomplete rules and makes post permalinks and 404s fall through to the homepage.

Playground ships a mu-plugin that 301s `/sitemap.xml` to `/wp-sitemap.xml`. Launch blanks that file so the mounted plugin can own the endpoint.

State is written under the consumer `.local/playground/`, not in this folder.

## Issues

Node.js 20.18 or higher must be on your PATH.

`stop` sends a graceful tree kill first, then force, and waits until `sites/<id>/database/.ht.sqlite` is unlocked. If a hard kill still leaves that file unreadable, retry launch or use `--site` with a new id. Deleting `.ht.sqlite` forces a fresh install for that site.

PowerShell strips quotes from `--json "{...}"`. Use `--json-file <path>` (resolved from `--root` when relative).
