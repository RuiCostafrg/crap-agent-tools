// Which files and lines differ between a base commit and the working tree.
// Read-only: only git plumbing that inspects state, with optional index locks disabled.
import { ToolError, run, findOnPath } from "./exec.mjs";

const MAX_LIST_BYTES = 8 * 1024 * 1024;
const MAX_PATCH_BYTES = 32 * 1024 * 1024;

// Names git would quote in a patch header (or that did not decode as UTF-8); their files count as changed in full.
const NEEDS_QUOTING = /["\\\p{Cc}]|\u{FFFD}/u;

/**
 * Changed files between merge-base(base, HEAD) and the working tree, staged,
 * unstaged and untracked alike, limited to `root` and to paths `select` accepts.
 * Each file carries either `whole: true` or the changed line ranges of its new
 * side and the positions of pure deletions (the new-side line they follow).
 */
export async function changedFiles({ root, base = "HEAD", select, env = process.env, signal }) {
  const gitPath = await findOnPath("git", env);
  if (!gitPath) throw new ToolError("git_not_found", "git was not found on PATH.");
  const gitEnv = { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  const git = async (args, maxStdoutBytes = MAX_LIST_BYTES) => {
    const result = await run(gitPath, ["--no-pager", "--literal-pathspecs", "-c", "core.quotepath=off", ...args],
      { cwd: root, env: gitEnv, signal, maxStdoutBytes });
    if (result.overflow) throw new ToolError("diff_too_large", "The git diff is too large to analyse.", "Use a closer base or a narrower root.");
    if (result.timedOut) throw new ToolError("git_failed", "git did not finish in time.");
    return result;
  };

  const inside = await git(["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.toString().trim() !== "true") {
    throw new ToolError("not_a_git_repository", "The project root is not inside a git work tree.");
  }
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head.code !== 0) throw new ToolError("no_commits", "The repository has no commits yet, so there is nothing to diff against.");
  let mergeBase = head.stdout.toString().trim();
  if (base !== "HEAD") {
    const resolved = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`]);
    if (resolved.code !== 0) throw new ToolError("unknown_base", `The base ref ${JSON.stringify(base)} does not name a commit in this repository.`);
    const merged = await git(["merge-base", resolved.stdout.toString().trim(), "HEAD"]);
    if (merged.code !== 0) throw new ToolError("no_merge_base", `HEAD and ${JSON.stringify(base)} have no common ancestor.`);
    mergeBase = merged.stdout.toString().trim();
  }

  const diffOptions = ["--find-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules",
    "--src-prefix=a/", "--dst-prefix=b/", "--relative"];
  const listed = await git(["diff", "--name-status", "-z", ...diffOptions, mergeBase, "--"]);
  if (listed.code !== 0) throw new ToolError("git_failed", "git diff failed.");
  const files = [], pathspecs = [];
  const fields = listed.stdout.toString("utf8").split("\0");
  for (let index = 0; index + 1 < fields.length;) {
    const status = fields[index++][0];
    const renamed = status === "R" || status === "C";
    const from = renamed ? fields[index++] : undefined;
    const path = fields[index++];
    if (status === "D" || !path || !select(path)) continue;
    // An added file, or one whose name cannot be matched in patch output, is changed in full.
    const whole = status === "A" || NEEDS_QUOTING.test(path);
    files.push({ path, status: renamed ? "renamed" : status === "A" ? "added" : "modified", whole, ranges: [], deletions: [] });
    if (!whole) pathspecs.push(path, ...(from ? [from] : []));
  }

  const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked.code !== 0) throw new ToolError("git_failed", "git ls-files failed.");
  for (const path of untracked.stdout.toString("utf8").split("\0")) {
    if (path && select(path)) files.push({ path, status: "untracked", whole: true, ranges: [], deletions: [] });
  }

  if (pathspecs.length) {
    const patch = await git(["diff", "-U0", ...diffOptions, mergeBase, "--", ...pathspecs], MAX_PATCH_BYTES);
    if (patch.code !== 0) throw new ToolError("git_failed", "git diff failed.");
    applyPatch(patch.stdout.toString("utf8"), new Map(files.filter(file => !file.whole).map(file => [file.path, file])));
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { base, mergeBase, files };
}

/** Record each hunk of a zero-context patch on the file it belongs to. */
function applyPatch(text, byPath) {
  const lines = text.split("\n");
  let file = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith("diff --git ")) { file = null; continue; }
    if (line.startsWith("+++ b/")) { file = byPath.get(line.slice(6).replace(/\t$/, "")) ?? null; continue; }
    if (line.startsWith("Binary files ") && lines[index - 1] !== undefined) {
      // No hunks to read: find the file from the header and count it as changed in full.
      const match = /^Binary files .* and b\/(.*) differ$/.exec(line);
      const binary = match && byPath.get(match[1]);
      if (binary) binary.whole = true;
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const removed = hunk[1] === undefined ? 1 : Number(hunk[1]);
    const start = Number(hunk[2]);
    const added = hunk[3] === undefined ? 1 : Number(hunk[3]);
    if (file) {
      if (added > 0) file.ranges.push([start, start + added - 1]);
      else file.deletions.push(start);
    }
    // Skip the hunk body so its content is never read as a header.
    for (let body = removed + added; body > 0 && index + 1 < lines.length;) {
      if (!lines[++index].startsWith("\\")) body--;
    }
  }
}
