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
 * A fake `ts-crap` in its own directory. Behaviour comes from environment variables:
 * FAKE_VERSION (default "ts-crap 2.4.0"), FAKE_REPORT (file whose bytes are printed),
 * FAKE_EXIT, FAKE_STDERR, FAKE_SLEEP_MS, FAKE_ARGS_LOG (file that receives the scan arguments).
 */
export async function fakeScanner() {
  const bin = await tempDir("crap-agent-fake-");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write((process.env.FAKE_VERSION ?? "ts-crap 2.4.0") + "\\n"); process.exit(0); }
if (process.env.FAKE_ARGS_LOG) fs.writeFileSync(process.env.FAKE_ARGS_LOG, JSON.stringify(args));
const finish = () => {
  if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR + "\\n");
  if (process.env.FAKE_REPORT && fs.existsSync(process.env.FAKE_REPORT)) process.stdout.write(fs.readFileSync(process.env.FAKE_REPORT));
  process.exitCode = Number(process.env.FAKE_EXIT ?? 0);
};
const sleep = Number(process.env.FAKE_SLEEP_MS ?? 0);
if (sleep) setTimeout(finish, sleep); else finish();
`;
  await writeFile(path.join(bin, "ts-crap"), script);
  await chmod(path.join(bin, "ts-crap"), 0o755);
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
