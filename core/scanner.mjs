// Find the scanner executable and check that it is a version this tool can read.
import { stat, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { ToolError, run, findOnPath, cleanText } from "./exec.mjs";

const VERSION_TIMEOUT_MS = 15_000;

async function isExecutableFile(file) {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Locate the scanner. Lookup order:
 *   1. `scannerPath`, an absolute path given by the caller;
 *   2. the project's own platform binary under `ROOT/node_modules`, only when
 *      `allowProjectScanner` is true (that binary comes from the repository being analysed);
 *   3. the first executable named like the scanner on PATH (absolute entries only).
 * The first candidate found is used; a broken candidate is an error, not a fallthrough,
 * so the answer never silently comes from a different scanner than the one configured.
 */
export async function locateScanner({ adapter, scannerPath, root, allowProjectScanner = false, env = process.env, signal }) {
  let candidate = null, source = null;
  if (scannerPath !== undefined) {
    if (typeof scannerPath !== "string" || !path.isAbsolute(scannerPath)) {
      throw new ToolError("invalid_argument", "The scanner path must be an absolute path.");
    }
    if (!(await isExecutableFile(scannerPath))) {
      throw new ToolError("scanner_not_found", `The configured ${adapter.name} path is not an executable file.`);
    }
    candidate = scannerPath; source = "explicit";
  }
  if (!candidate && allowProjectScanner) {
    for (const file of adapter.projectBinaries(root)) {
      if (await isExecutableFile(file)) { candidate = file; source = "project"; break; }
    }
  }
  if (!candidate) {
    candidate = await findOnPath(adapter.command, env);
    source = "path";
  }
  if (!candidate) {
    throw new ToolError("scanner_not_found", `${adapter.name} was not found on PATH.`, adapter.installHint);
  }

  let result;
  try {
    result = await run(candidate, adapter.versionArguments, { env, signal, timeoutMs: VERSION_TIMEOUT_MS, maxStdoutBytes: 4096 });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ToolError("scanner_unusable", `${adapter.name} could not be started (${cleanText(error.code ?? error.message, 80)}).`,
      "Check that the executable matches this operating system and CPU.");
  }
  const text = result.stdout.toString("utf8").trim();
  const version = result.code === 0 ? adapter.parseVersion(text) : null;
  if (!version) {
    throw new ToolError("scanner_unusable", `${adapter.name} did not report a version it recognises.`,
      "Check that the configured executable is the real scanner.");
  }
  if (compare(version, adapter.minimumVersion) < 0) {
    throw new ToolError("scanner_too_old",
      `${adapter.name} ${version.join(".")} is older than ${adapter.minimumVersion.join(".")}, the oldest version this tool supports.`,
      `Install ${adapter.name} ${adapter.minimumVersion.join(".")} or newer.`);
  }
  return { path: candidate, source, version: version.join(".") };
}
