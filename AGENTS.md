# Repository instructions for coding agents

Read this file before editing anything in this repository. It applies to the entire checkout. `CLAUDE.md` points here so agents share one set of project rules. Explicit user instructions and higher-priority platform instructions take precedence over the workflow defaults below.

## Before making changes

1. Check `git status --short --branch`, the current branch, and the relevant remote/PR state. Preserve unrelated user changes.
2. Read `README.md`, `manifest.json`, the implementation you will change, and its nearby tests. Inspect additional instruction files in the directories you touch.
3. Establish current behavior from code, fixtures, actual DOM/API responses, and runtime output. Documentation can lag behind implementation; report discrepancies rather than guessing.
4. Choose the smallest coherent change. Keep working configuration and conventions unless the task requires changing them.
5. Use targeted searches and bounded output. Exclude dependencies, Git internals, caches, and generated artifacts from broad searches.

Work through **inspect → understand → implement → verify**. Do not ask the user to run commands or collect information you can access yourself. For a request marked `pbp`, investigate first, present a concrete plan, and wait for approval before implementation. `ga` means execute the agreed work.

## Project map

This is a Manifest V3 browser extension for Google Forms, using plain JavaScript and HTML/CSS. There is no application server, package manifest, bundler, or required dependency installation on the current default branch.

| File | Responsibility |
| --- | --- |
| `manifest.json` | Browser entry points, permissions, content-script matching, and packaged assets |
| `background.js` | Provider requests, message handling, answer parsing/matching, fallback, and counters |
| `models.js` | Shared provider/model options used by the popup and background logic |
| `content.js` | Google Forms scraping, Shadow DOM overlay, answer caching, selection, and batch filling |
| `popup.html`, `popup.js` | Provider/key settings, connection testing, and counter controls |
| `tests/background.test.cjs` | Worker behavior with fake provider and storage boundaries |
| `tests/popup.test.cjs` | Settings persistence and connection-test regressions |
| `tests/browser.test.cjs` | Actual content script running against local headless Chrome fixtures |

Inspect the checked-out manifest for the actual startup path. Browser-porting work may add loaders, event-page scripts, privacy files, or tests; do not assume an open PR has already merged. Preserve both browser startup paths whenever the branch supports multiple browsers.

## Implementation rules

- Prefer existing patterns and native browser/JavaScript capabilities. Do not introduce a framework, build system, package manager, runtime dependency, or unrelated upgrade for a focused change.
- Keep provider/model configuration in `models.js`; do not duplicate model lists in the popup or background logic.
- Verify API schemas and model IDs using official documentation and representative responses. A model appearing in a listing does not prove generation works with a particular key. Distinguish invalid IDs, missing access/quota, and temporary overload.
- Keep provider requests in background logic. Content scripts communicate through extension messages. Handle asynchronous errors explicitly and keep message channels open until responses are sent.
- Never commit credentials or real user/form data. Use fake keys and deterministic responses in tests. Use live credentials only within the user's authorized scope, and keep them out of command text, logs, screenshots, fixtures, and PR descriptions.
- Escape untrusted question, option, answer, and error text before rendering HTML; prefer `textContent` for plain text. Preserve Shadow DOM isolation and narrow host permissions.
- Preserve error details without logging secrets. Do not silently swallow operational failures or invent fallback behavior to hide an unknown schema.

## Behavior that must remain correct

- Exact option labels, including numeric/punctuated labels such as `1.5`, survive cleanup. Ambiguous or partial matches must not select an option.
- Checkbox answers support multiple exact matches. Applying them is idempotent and clears incorrect checked options.
- Cache identity includes the question element and its title, description, type, and options. Repeated titles must not share unrelated answers.
- Nested checkbox list items are not separate questions. Sections with the same question count still refresh correctly.
- Late responses cannot fill a different or changed question. Batch filling is sequential; Stop prevents late application and additional requests. Existing batches affect the current section only and never click Next or Submit.
- Text filling uses the appropriate native setter and input/change events. Unsupported or unavailable controls are reported instead of counted as filled.
- Testing an unsaved key/provider/model never changes saved settings or counters. Provider fallback does not overwrite the saved model.
- Concurrent successful answers retain every counter increment. The displayed count is not a provider quota or billing meter.

Change these contracts only when the user requests different behavior; update their consumers, tests, and documentation together.

## Verification

Run the narrowest relevant checks during development. For a meaningful extension change, the existing full suite is:

```sh
node --check background.js
node --check content.js
node --check popup.js
node --check models.js
node --test tests/*.test.cjs
git diff --check
```

Check newly added JavaScript entry points too. Browser fixtures use an isolated temporary profile and fake API responses. They use the standard macOS Chrome path or `google-chrome`; `CHROME_PATH` selects another executable. Read test output: a skipped browser check is not a pass.

For DOM/selection fixes, reproduce the failing markup and test the affected path plus nearby regressions. Synthetic fixtures do not establish compatibility with every live Google Forms layout. For browser-support changes, test actual extension startup, messaging, storage, permissions, and UI in the target engine; clearly distinguish release Firefox from Gecko-based browsers and mocks.

If Firefox tooling/configuration is present on the checked-out branch, follow that branch's documented `web-ext` lint/build and opt-in Gecko test commands. Keep artifacts out of Git. Report lint warnings, skipped checks, missing tooling, and unverified live-provider behavior accurately. Do not claim signing or store publication based on a successful unsigned build.

Documentation-only changes need link/path/command checks and diff review; do not add implementation-mirroring tests or require live API calls for them.

## Git and delivery

- Confirm the remote default branch; this repository currently uses `main`. Do not create or rename `master` merely because it was mentioned generically.
- By default, start code changes from the latest default branch on a separate feature branch and open a PR back to it. Honor an explicitly requested branch name and an explicit request to push directly to the default branch.
- Do not merge an unrelated open PR, force-push, reset user work, delete persistent data, or publish/sign an extension without appropriate user authorization.
- Use coherent Conventional Commit messages. Inspect staged changes for unintended edits, formatting churn, debug leftovers, credentials, and generated files before committing.
- Check for an existing branch/PR before creating duplicates. Prefer `gh`; use `--body-file` for multiline PR descriptions. When requested, add the repository owner as reviewer or assignee and verify that GitHub applied it.
- Keep `README.md` and any privacy/permission disclosures aligned with actual behavior. Keep this file current when architecture, commands, or important contracts change; keep `CLAUDE.md` as a pointer rather than a duplicate.
- Finish with what changed, why, the verification performed, limitations, and commit/PR links when applicable. Be concise; never report success solely because a command exited successfully.
