// Which files are this project's tests — stated, rather than left to a default
// that is wrong here.
//
// There was no config at all until now, so vitest used its built-in glob and
// walked everything under webapp/. That is fine until the directory contains a
// second copy of the repository, and it does: `.claude/worktrees/` holds full
// checkouts, each with its own `webapp/tests/`. `npx vitest run` collected 44
// files from two copies, and because several suites bind fixed ports, the two
// copies raced each other for them — the failures that produced (429s,
// ECONNREFUSED) look exactly like real defects and are not. Hours go into
// chasing a bug in code that is fine.
//
// So: the tests are the ones in this directory's `tests/`, and nowhere else.
// `dir` is what actually fixes it — the scan starts inside `tests/`, and a
// worktree's copy lives at `.claude/worktrees/<name>/webapp/tests/`, which that
// scan never reaches. The extra `exclude` entries are belt to that braces: they
// say the intent out loud, so a later widening cannot quietly re-admit a second
// copy.
//
// `dir` rather than an `include` of `tests/**/*.test.ts`, because `include` is
// matched relative to the scan directory, not to the root: pinning the folder
// in `include` broke `npx vitest run --dir tests` — the command this repo told
// people to use while there was no config — with "No test files found", which
// reads exactly like a repo with no tests. Stating the folder once, in the
// option that means folder, leaves both spellings working and agreeing.
//
// Deliberately NOT solved by deleting the worktree. It is somebody's working
// checkout; a test runner is not the thing that gets to decide that.
import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    dir: 'tests',
    include: ['**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,          // node_modules, dist, .idea/.git/.cache
      '**/.claude/**',                    // agent worktrees and scratch checkouts
      '**/worktrees/**',                  // the same thing wherever else it lands
    ],
  },
});
