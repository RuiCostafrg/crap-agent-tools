// Bounded child processes: no shell, no stdin, capped output, timeout and cancellation.
import { spawn } from "node:child_process";
import { stat, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/** An expected failure that is reported to the caller as a structured error. */
export class ToolError extends Error {
  constructor(kind, message, hint) {
    super(message);
    this.kind = kind;
    this.hint = hint;
  }
}

export function checkAbort(signal) {
  if (signal?.aborted) throw new Error("Operation cancelled.");
}

// Control (Cc), format/bidi (Cf, includes BOM) and line/paragraph separators never reach the model.
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** One line of text with control characters replaced, cut to a fixed length. */
export function cleanText(value, max) {
  const text = String(value).replace(UNSAFE_TEXT, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/**
 * Absolute path of an executable on PATH. Relative and empty PATH entries are
 * skipped, so a directory inside the scanned project is never searched implicitly.
 */
export async function findOnPath(name, env = process.env) {
  const suffixes = process.platform === "win32" ? [".exe"] : [""];
  for (const directory of String(env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(directory, name + suffix);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, constants.X_OK);
        return candidate;
      } catch { /* not here */ }
    }
  }
  return null;
}

/**
 * Run a command to completion. Resolves with the exit code and the captured
 * output; `overflow` is set (and the child killed) when stdout exceeds its cap.
 * Stderr beyond its cap is dropped. Rejects on spawn errors and cancellation.
 */
export function run(command, args, { cwd, env, signal, timeoutMs = 120_000, maxStdoutBytes, maxStderrBytes = 16 * 1024 }) {
  return new Promise((resolve, reject) => {
    checkAbort(signal);
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout = [], stderr = [];
    let stdoutBytes = 0, stderrBytes = 0, overflow = false, timedOut = false, settled = false;
    const kill = () => { child.kill("SIGKILL"); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle(value);
    };
    child.stdout.on("data", chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) { overflow = true; kill(); } else stdout.push(chunk);
    });
    child.stderr.on("data", chunk => {
      if (stderrBytes < maxStderrBytes) stderr.push(chunk.subarray(0, maxStderrBytes - stderrBytes));
      stderrBytes += chunk.length;
    });
    child.on("error", error => finish(reject, error));
    child.on("close", code => {
      if (signal?.aborted) return finish(reject, new Error("Operation cancelled."));
      finish(resolve, {
        code, overflow, timedOut,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
