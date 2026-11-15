// Test fixtures: throwaway git repositories and a scripted stand-in for ts-crap.
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm, chmod, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findOnPath } from "../core/exec.mjs";

const gitPath = await findOnPath("git");
if (!gitPath) throw new Error("Tests need git on PATH.");

/** The real scanner for end-to-end tests: TS_CRAP_TEST_BIN, else ts-crap on PATH, else null (tests skip). */
export const realScanner = process.env.TS_CRAP_TEST_BIN || (await findOnPath("ts-crap"));
/** The real dotnet-crap: DOTNET_CRAP_TEST_BIN, else dotnet-crap on PATH, else null (tests skip). */
export const realDotnetScanner = process.env.DOTNET_CRAP_TEST_BIN || (await findOnPath("dotnet-crap"));

/** A PATH holding git and node but no ts-crap, plus any extra directories first. */
export function pathWith(...directories) {
  return [...directories, path.dirname(gitPath), path.dirname(process.execPath)].join(path.delimiter);
}

export async function tempDir(prefix) {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

/** Create a git repository with `files` committed; returns helpers bound to it. */
export async function repo(files = {}) {
  const root = await tempDir("crap-agent-repo-");
  const home = await tempDir("crap-agent-home-");
  const env = {
    ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const git = (...args) => execFileSync(gitPath, args, { cwd: root, env, encoding: "utf8" });
  const write = async (name, text) => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  };
  git("init", "-q", "-b", "main");
  for (const [name, text] of Object.entries(files)) await write(name, text);
  if (Object.keys(files).length) { git("add", "-A"); git("commit", "-qm", "base"); }
  return {
    root, git, write,
    commit(message = "change") { git("add", "-A"); git("commit", "-qm", message); },
    async cleanup() { await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); },
  };
}

/**
 * A fake scanner in its own directory. Behaviour comes from environment variables
 * named with `prefix`: VERSION (default "<name> <version>"), REPORT (file whose bytes
 * are printed), EXIT, STDERR, SLEEP_MS, ARGS_LOG (file that receives the scan
 * arguments), SYNTAX (a path: when it is among the arguments, fail the way
 * dotnet-crap does on invalid C#).
 */
export async function fakeScanner({ name = "ts-crap", version = "2.4.0", prefix = "FAKE_" } = {}) {
  const bin = await tempDir("crap-agent-fake-");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const env = key => process.env["${prefix}" + key];
if (args[0] === "--version") { process.stdout.write((env("VERSION") ?? "${name} ${version}") + "\\n"); process.exit(0); }
if (env("ARGS_LOG")) fs.appendFileSync(env("ARGS_LOG"), JSON.stringify(args) + "\\n");
const finish = () => {
  if (env("SYNTAX") && args.includes(env("SYNTAX"))) {
    process.stderr.write("error: invalid C# syntax in " + env("SYNTAX") + "\\n");
    process.exitCode = 2;
    return;
  }
  if (env("STDERR")) process.stderr.write(env("STDERR") + "\\n");
  if (env("REPORT") && fs.existsSync(env("REPORT"))) process.stdout.write(fs.readFileSync(env("REPORT")));
  process.exitCode = Number(env("EXIT") ?? 0);
};
const sleep = Number(env("SLEEP_MS") ?? 0);
if (sleep) setTimeout(finish, sleep); else finish();
`;
  await writeFile(path.join(bin, name), script);
  await chmod(path.join(bin, name), 0o755);
  return { bin, cleanup: () => rm(bin, { recursive: true, force: true }) };
}

/** A schema-valid ts-crap report v1 for the given function rows. */
export function report(functions, extra = {}) {
  const rows = functions.map((row, index) => ({
    identity: index.toString(16).padStart(64, "0"), column: 1, column_utf16: 1, coverage: 0, failed: false, ...row,
  }));
  return JSON.stringify({
    version: 1, threshold: 10, files_scanned: new Set(rows.map(row => row.path)).size, failed: rows.some(row => row.failed),
    files_missing_coverage: 0, functions_missing_coverage: 0, completeness_failed: false, functions: rows, ...extra,
  });
}

/** A dotnet-crap 0.1.0 report for the given rows (`file` paths); failed follows the threshold. */
export function dotnetReport(functions, extra = {}) {
  const threshold = extra.threshold ?? 10;
  const rows = functions.map(row => ({ kind: "method_declaration", column: 5, coverage: null, ...row }));
  return JSON.stringify({
    threshold, files_scanned: new Set(rows.map(row => row.file)).size,
    coverage_complete: rows.every(row => row.coverage !== null), functions: rows,
    failed: rows.some(row => row.crap > threshold), ...extra,
  });
}

export const SAMPLE = `export function simple(a: number): number {
  return a + 1;
}

export function branchy(a: number, b: string | null): number {
  if (a > 1 && b) {
    for (const c of b) {
      if (c === "x" || c === "y") return 1;
    }
  }
  return a > 5 ? 2 : 3;
}
`;
