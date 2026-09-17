# Agent Guide for `flood-nagoya`

This file is for AI coding agents working in this repository. It states how
to run the checks and where edits belong. The human-facing contribution
guide is [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md).

## Commands

The `just` task runner drives the common commands:

```sh
just fix            # auto-fix formatting and lint
just lint
just test
just check
```

Run `just fix` before committing to apply formatting
and lint fixes, then `just check` (or `lint` + `test`
+ `type-check` individually) before finishing a change.
The repo-hygiene checks (secrets, workflow linting, YAML validity,
conventional commit messages) run in CI, not as local hooks — the lint and
fix tasks work anywhere, including outside a git repository.

Type checking uses basedpyright plus `pyrefly`; `deptry`,
`vulture`, and `typos` also run as part of type-check.


Build the docs with `just docs`.

## Where to edit

- Application/package code: `src/flood_nagoya/`
- Tests: `tests/`
- Docs: `README.md` and `docs/`

Keep 100% coverage where it exists; do not lower it.


Data, notebooks, and reports (`data/`, `notebooks/`, `models/`,
`reports/`) are analysis artifacts — keep generated outputs out of git.

## Commits and CI

- Use [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, ...); the commit-msg hook enforces it.
- CI runs lint, type-check, and tests on every push
 plus a docs build; keep all of them green.
