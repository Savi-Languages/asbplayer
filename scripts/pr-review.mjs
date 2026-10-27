#!/usr/bin/env node
// Throwaway worktrees that preview a PR as if it were merged into main.
//
//   pnpm pr-review <N>          # = pr-review:setup <N>
//   pnpm pr-review:clean [N]    # one preview, or every preview
//
// (asbplayer runs the same file: `yarn pr-review …`.)
//
// GitHub's "mergeable" check only catches LINE conflicts. Branches that
// diverged from main long ago can merge cleanly and still be wrong — main
// renamed a function the PR calls, changed a contract the PR relies on — so a
// review has to happen on the merge RESULT, built and tested. `setup`:
//
//   1. fetches origin, fast-forwards local `main` to origin/main;
//   2. fetches the PR head straight from GitHub (refs/pull/N/head — works for
//      fork PRs too, no `gh` needed);
//   3. creates branch `preview-pr-N` off main in the sibling worktree
//      `<repo>-preview-pr-N`, and merges the PR head into it.
//
// A conflicted merge is left in place, mid-merge, for you to resolve there.
// The preview branch has NO upstream, so a stray `git push` cannot reach main.
//
// `clean` finds previews by name alone — branches `preview-pr-*` and the
// worktrees that have them checked out — so there is no registry to drift.
// It force-removes: a preview is throwaway by definition.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const PREFIX = "preview-pr-";
const REMOTE = "origin";

function git(args, { cwd = process.cwd(), allowFail = false, quiet = false } = {}) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", quiet ? "pipe" : "inherit"],
  });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Failure(`git ${args.join(" ")} failed (exit ${r.status})`);
  }
  return { ok: r.status === 0, out: r.stdout.trim(), err: (r.stderr ?? "").trim() };
}

class Failure extends Error {}

/** The package manager that launched us, for the hints we print. */
const pm = (process.env.npm_config_user_agent ?? "").startsWith("yarn") ? "yarn" : "pnpm";

/** `git worktree list --porcelain` as [{ path, branch }], main worktree first. */
function worktrees(cwd) {
  const list = [];
  for (const block of git(["worktree", "list", "--porcelain"], { cwd }).out.split(/\n\n+/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path) continue;
    list.push({ path: resolve(path), branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null });
  }
  return list;
}

function repoContext() {
  const inRepo = git(["rev-parse", "--show-toplevel"], { allowFail: true, quiet: true });
  if (!inRepo.ok) throw new Failure("not inside a git repository");
  // Git always lists the main worktree first, so this holds from any worktree —
  // including from inside a preview.
  const mainRoot = worktrees(process.cwd())[0].path;
  const head = git(["symbolic-ref", "--short", `refs/remotes/${REMOTE}/HEAD`], {
    cwd: mainRoot,
    allowFail: true,
    quiet: true,
  });
  const base = head.ok ? head.out.slice(REMOTE.length + 1) : "main";
  return { mainRoot, repoName: basename(mainRoot), base };
}

function parsePr(arg) {
  if (!/^[1-9]\d*$/.test(arg ?? "")) throw new Failure(`expected a PR number, got ${JSON.stringify(arg)}`);
  return arg;
}

/** Fast-forward local <base> to <remote>/<base>, wherever it is checked out. */
function updateBase({ mainRoot, base }) {
  const remoteBase = `${REMOTE}/${base}`;
  const local = git(["rev-parse", "--verify", "--quiet", `refs/heads/${base}`], {
    cwd: mainRoot,
    allowFail: true,
    quiet: true,
  });
  if (!local.ok) {
    git(["branch", "--no-track", base, remoteBase], { cwd: mainRoot, quiet: true });
    return;
  }
  const upToDate = git(["merge-base", "--is-ancestor", remoteBase, base], { cwd: mainRoot, allowFail: true });
  if (upToDate.ok) {
    const ahead = git(["rev-list", "--count", `${remoteBase}..${base}`], { cwd: mainRoot }).out;
    if (ahead !== "0") {
      console.warn(`warning: local ${base} is ${ahead} commit(s) ahead of ${remoteBase}; previewing against ${remoteBase}.`);
    }
    return;
  }
  const canFf = git(["merge-base", "--is-ancestor", base, remoteBase], { cwd: mainRoot, allowFail: true });
  if (!canFf.ok) {
    console.warn(`warning: local ${base} has diverged from ${remoteBase}; left it alone, previewing against ${remoteBase}.`);
    return;
  }
  const checkedOut = worktrees(mainRoot).find((w) => w.branch === base);
  if (checkedOut) {
    // Updating the ref under a checked-out branch would leave its worktree
    // looking modified; let `merge` move the files along with it.
    const ff = git(["merge", "--ff-only", "--quiet", remoteBase], { cwd: checkedOut.path, allowFail: true });
    if (!ff.ok) {
      console.warn(
        `warning: could not fast-forward ${base} in ${checkedOut.path} (local changes?); previewing against ${remoteBase}.`,
      );
      return;
    }
  } else {
    git(["update-ref", `refs/heads/${base}`, remoteBase], { cwd: mainRoot });
  }
  console.log(`Fast-forwarded local ${base} to ${remoteBase}.`);
}

function setup(prArg) {
  const pr = parsePr(prArg);
  const ctx = repoContext();
  const { mainRoot, repoName, base } = ctx;
  const branch = `${PREFIX}${pr}`;
  const path = join(dirname(mainRoot), `${repoName}-${PREFIX}${pr}`);

  const branchExists = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: mainRoot,
    allowFail: true,
    quiet: true,
  }).ok;
  if (branchExists || existsSync(path)) {
    throw new Failure(
      `a preview of PR #${pr} already exists (${branchExists ? `branch ${branch}` : path}).\n` +
        `Run \`${pm} pr-review:clean ${pr}\` first to rebuild it.`,
    );
  }

  console.log(`Fetching ${REMOTE}…`);
  git(["fetch", "--quiet", REMOTE], { cwd: mainRoot });
  updateBase(ctx);

  console.log(`Fetching PR #${pr}…`);
  const fetched = git(["fetch", "--quiet", REMOTE, `refs/pull/${pr}/head`], {
    cwd: mainRoot,
    allowFail: true,
    quiet: true,
  });
  if (!fetched.ok) throw new Failure(`could not fetch PR #${pr} from ${REMOTE}:\n${fetched.err}`);
  const prHead = git(["rev-parse", "FETCH_HEAD"], { cwd: mainRoot }).out;
  const baseHead = git(["rev-parse", `${REMOTE}/${base}`], { cwd: mainRoot }).out;

  // --no-track: the start point is a remote-tracking branch, so git would
  // otherwise make origin/main the upstream and a bare `git push` would aim
  // at main.
  git(["worktree", "add", "--quiet", "--no-track", "-b", branch, path, `${REMOTE}/${base}`], { cwd: mainRoot });

  const merged = git(
    ["merge", "--no-ff", "--no-edit", "-m", `Preview: merge PR #${pr} (${prHead.slice(0, 8)}) into ${base}`, prHead],
    { cwd: path, allowFail: true, quiet: true },
  );

  console.log(`
Preview of PR #${pr}
  worktree  ${path}
  branch    ${branch}
  ${base.padEnd(8)}  ${baseHead.slice(0, 8)}
  PR head   ${prHead.slice(0, 8)}`);

  if (!merged.ok) {
    const conflicts = git(["diff", "--name-only", "--diff-filter=U"], { cwd: path }).out;
    console.error(`
The merge did not apply cleanly; the worktree is left mid-merge so you can
resolve it there.${conflicts ? `\nConflicted files:\n${conflicts.replace(/^/gm, "  ")}` : `\n${merged.err}`}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nMerged cleanly. Dependencies are not installed — run \`${pm} install\` in the worktree.`);
}

function clean(prArg) {
  const pr = prArg === undefined ? null : parsePr(prArg);
  const { mainRoot, repoName } = repoContext();
  const isPreview = (branch) =>
    branch != null && (pr ? branch === `${PREFIX}${pr}` : branch.startsWith(PREFIX));
  const previewDir = (path) =>
    pr ? basename(path) === `${repoName}-${PREFIX}${pr}` : basename(path).startsWith(`${repoName}-${PREFIX}`);

  // Worktrees first: git refuses to delete a branch that is checked out.
  const [, ...linked] = worktrees(mainRoot);
  let removed = 0;
  for (const w of linked.filter((w) => isPreview(w.branch) || previewDir(w.path))) {
    // --force twice also removes a worktree that is locked.
    const r = git(["worktree", "remove", "--force", "--force", w.path], { cwd: mainRoot, allowFail: true, quiet: true });
    if (r.ok) {
      console.log(`Removed worktree ${w.path}`);
      removed++;
    } else {
      console.warn(`warning: could not remove worktree ${w.path}:\n${r.err}`);
      process.exitCode = 1;
    }
  }
  // Worktrees whose directory was deleted by hand still pin their branch.
  git(["worktree", "prune"], { cwd: mainRoot });

  const pattern = pr ? `refs/heads/${PREFIX}${pr}` : `refs/heads/${PREFIX}*`;
  const branches = git(["for-each-ref", "--format=%(refname:short)", pattern], { cwd: mainRoot })
    .out.split("\n")
    .filter(isPreview);
  for (const b of branches) {
    const r = git(["branch", "--quiet", "-D", b], { cwd: mainRoot, allowFail: true, quiet: true });
    if (r.ok) {
      console.log(`Deleted branch ${b}`);
    } else {
      console.warn(`warning: could not delete branch ${b}:\n${r.err}`);
      process.exitCode = 1;
    }
  }

  if (removed === 0 && branches.length === 0) {
    console.log(pr ? `No preview of PR #${pr} to clean.` : "No PR previews to clean.");
  }
}

const usage = `usage: ${pm} pr-review[:setup] <pr-number>
       ${pm} pr-review:clean [pr-number]`;

try {
  const [command, ...args] = process.argv.slice(2);
  if (args.length > 1) throw new Failure(usage);
  if (command === "setup") {
    if (args[0] === undefined) throw new Failure(usage);
    setup(args[0]);
  } else if (command === "clean") {
    clean(args[0]);
  } else {
    throw new Failure(usage);
  }
} catch (e) {
  if (!(e instanceof Failure)) throw e;
  console.error(`pr-review: ${e.message}`);
  process.exitCode = 2;
}
