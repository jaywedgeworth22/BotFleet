// GitHub tools for the HTTP driver lane — clone, commit, push, and manage a
// pull request or issue, confined to this bot's own workspace directory.
//
// Deliberately narrower than routing the same work through the generic
// `bash` tool: argv-only exec (no shell string, so no injection surface),
// a fixed action per registry record (each gets its own approval summary
// and read/write classification instead of one blanket "bash: <command>"
// card), and a real-path confinement check on every repo directory before
// any git/gh command runs against it — `read_file`/`write_file`/`edit_file`
// only DEFAULT into the workspace and do not enforce this, so this module
// does not assume that confinement exists anywhere else and checks it here.
//
// Requires the host's own `gh`/git authentication (whatever the person set
// up with `gh auth login`) — this tool never receives, stores, or asks for
// a token itself.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { TurnToolOutcome } from "../contracts.ts";
import { isInside, realOrResolved } from "../bot-cwd.ts";
import { workspaceDir } from "../workspace.ts";
import type { ComputerToolExecutor } from "./computer.ts";

const SAFE_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9/._-]{0,199}$/;
const SAFE_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_REPO_URL = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\.git)?$/;

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], cwd: string, timeoutMs = 60_000): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        const code = error ? Number((error as unknown as { code?: number }).code ?? 1) : 0;
        resolvePromise({ code, stdout: String(stdout || ""), stderr: String(stderr || "") });
      },
    );
  });
}

function outcome(result: ExecResult, okPrefix?: string): TurnToolOutcome {
  const body = [result.stdout.trim(), result.stderr.trim() ? `STDERR:\n${result.stderr.trim()}` : ""]
    .filter(Boolean)
    .join("\n\n");
  if (result.code !== 0) {
    return { kind: "error", content: body || `command exited with code ${result.code}`, detail: `exit ${result.code}` };
  }
  const content = body || "(command completed with no output)";
  return { kind: "result", content: okPrefix ? `${okPrefix}\n\n${content}` : content };
}

function invalid(message: string): TurnToolOutcome {
  return { kind: "error", content: message, detail: "invalid_argument" };
}

/** The bot's own workspace-relative repo directory, real-path confined —
 *  never trusts the model's `dir` string without checking a symlink or
 *  `..` didn't walk it out of the workspace. Null when missing, invalid, or
 *  outside the workspace. */
function confinedRepoDir(botId: string, dir: unknown): string | null {
  if (typeof dir !== "string" || !dir.trim()) return null;
  const root = workspaceDir(botId);
  const candidate = join(root, dir.trim());
  const real = realOrResolved(candidate);
  return isInside(real, realOrResolved(root)) ? candidate : null;
}

const MISSING_DIR = invalid(
  'dir must name a repo directory already cloned into this bot\'s workspace with github_clone (pass the same "dir" you used there).',
);

export function createGithubTools(botId: string): Record<string, ComputerToolExecutor> {
  const clone: ComputerToolExecutor = async (call) => {
    const repo = typeof call.arguments.repo === "string" ? call.arguments.repo.trim() : "";
    if (!repo || !(SAFE_REPO.test(repo) || SAFE_REPO_URL.test(repo))) {
      return invalid('repo must be "owner/repo" or a https://github.com/owner/repo(.git) URL');
    }
    const dirArg = typeof call.arguments.dir === "string" && call.arguments.dir.trim() ? call.arguments.dir.trim() : undefined;
    const dirName = dirArg ?? repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").split("/").pop()!;
    if (!SAFE_DIR_NAME.test(dirName)) return invalid("dir must be a plain folder name (letters, digits, . _ -)");
    const root = workspaceDir(botId);
    mkdirSync(root, { recursive: true });
    const target = join(root, dirName);
    if (existsSync(target)) return invalid(`"${dirName}" already exists in this bot's workspace — choose a different dir`);
    const url = repo.startsWith("https://") ? repo : `https://github.com/${repo}.git`;
    const result = await run("gh", ["repo", "clone", url, target], root, 120_000);
    return outcome(result, `Cloned into this bot's workspace as "${dirName}".`);
  };

  const withRepo = (
    handler: (repoDir: string, args: Record<string, unknown>) => Promise<TurnToolOutcome>,
  ): ComputerToolExecutor => async (call) => {
    const repoDir = confinedRepoDir(botId, call.arguments.dir);
    if (!repoDir || !existsSync(repoDir)) return MISSING_DIR;
    return handler(repoDir, call.arguments);
  };

  const status = withRepo(async (repoDir) => {
    const view = await run("gh", ["repo", "view", "--json", "name,owner,defaultBranchRef,url"], repoDir);
    const git = await run("git", ["status", "--short", "--branch"], repoDir);
    return outcome({
      code: view.code || git.code,
      stdout: [view.stdout.trim(), git.stdout.trim()].filter(Boolean).join("\n\n"),
      stderr: [view.stderr.trim(), git.stderr.trim()].filter(Boolean).join("\n"),
    });
  });

  const commit = withRepo(async (repoDir, args) => {
    const message = typeof args.message === "string" ? args.message.trim() : "";
    if (!message) return invalid("message is required");
    const files = Array.isArray(args.files) && args.files.every((f) => typeof f === "string") ? (args.files as string[]) : null;
    const add = await run("git", ["add", ...(files && files.length ? files : ["-A"])], repoDir);
    if (add.code !== 0) return outcome(add);
    return outcome(await run("git", ["commit", "-m", message], repoDir), "Committed.");
  });

  const push = withRepo(async (repoDir, args) => {
    const branch = typeof args.branch === "string" && args.branch.trim() ? args.branch.trim() : undefined;
    if (branch && !SAFE_BRANCH.test(branch)) return invalid("branch has an invalid name");
    const pushArgs = branch ? ["push", "-u", "origin", branch] : ["push"];
    return outcome(await run("git", pushArgs, repoDir), "Pushed.");
  });

  const prCreate = withRepo(async (repoDir, args) => {
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title) return invalid("title is required");
    const body = typeof args.body === "string" ? args.body : "";
    const prArgs = ["pr", "create", "--title", title, "--body", body];
    if (typeof args.base === "string" && args.base.trim()) prArgs.push("--base", args.base.trim());
    if (typeof args.branch === "string" && args.branch.trim()) prArgs.push("--head", args.branch.trim());
    return outcome(await run("gh", prArgs, repoDir), "Opened a pull request.");
  });

  const prView = withRepo(async (repoDir, args) => {
    const prArgs = ["pr", "view"];
    if (Number.isInteger(args.number)) prArgs.push(String(args.number));
    prArgs.push("--json", "number,title,state,url,statusCheckRollup,mergeable");
    return outcome(await run("gh", prArgs, repoDir));
  });

  const prList = withRepo(async (repoDir) => outcome(await run("gh", ["pr", "list", "--json", "number,title,state,url"], repoDir)));

  const prCheckout = withRepo(async (repoDir, args) => {
    if (!Number.isInteger(args.number)) return invalid("number is required");
    return outcome(await run("gh", ["pr", "checkout", String(args.number)], repoDir), "Checked out the pull request.");
  });

  const issueCreate = withRepo(async (repoDir, args) => {
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title) return invalid("title is required");
    const body = typeof args.body === "string" ? args.body : "";
    return outcome(await run("gh", ["issue", "create", "--title", title, "--body", body], repoDir), "Opened an issue.");
  });

  const issueView = withRepo(async (repoDir, args) => {
    if (!Number.isInteger(args.number)) return invalid("number is required");
    return outcome(await run("gh", ["issue", "view", String(args.number), "--json", "number,title,state,url,body"], repoDir));
  });

  const issueList = withRepo(async (repoDir) => outcome(await run("gh", ["issue", "list", "--json", "number,title,state,url"], repoDir)));

  return {
    github_clone: clone,
    github_status: status,
    github_commit: commit,
    github_push: push,
    github_pr_create: prCreate,
    github_pr_view: prView,
    github_pr_list: prList,
    github_pr_checkout: prCheckout,
    github_issue_create: issueCreate,
    github_issue_view: issueView,
    github_issue_list: issueList,
  };
}
