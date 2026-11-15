// Helpers shared by scanner adapters: bounded reads, report field checks and
// the native coverage-v1 file both ts-crap and dotnet-crap accept.
import { open } from "node:fs/promises";
import { ToolError } from "./exec.mjs";

const MAX_COVERAGE_BYTES = 64 * 1024 * 1024;

/** Read a whole regular file, or null when it is missing, too large or unreadable. */
export async function readBounded(file, maxBytes) {
  let handle;
  try {
    handle = await open(file, "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return null;
    return await handle.readFile("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** The error for a report this tool cannot trust. */
export function invalidReport(scanner, reason) {
  return new ToolError("invalid_scanner_output", `${scanner} produced a report this tool cannot trust: ${reason}.`);
}

export const isCount = value => Number.isSafeInteger(value) && value >= 0;
export const isLine = value => Number.isSafeInteger(value) && value >= 1;
export const isScore = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
/** Root-relative slash path, as both report schemas define it. */
export const isPath = value => typeof value === "string" && value.length > 0 && !/[\\:]/.test(value) &&
  !value.split("/").some(part => part === "" || part === "." || part === "..");

/** Parse a scanner's JSON output into an object, or throw invalid_scanner_output. */
export function parseObject(scanner, text) {
  let report;
  try { report = JSON.parse(text); } catch { throw invalidReport(scanner, "the output is not valid JSON"); }
  if (report === null || typeof report !== "object" || Array.isArray(report)) throw invalidReport(scanner, "the report is not a JSON object");
  return report;
}

/**
 * Line hits from a native coverage-v1 file that the scanner has already
 * accepted: Map of path to Map of line to hits. Null when the file cannot be
 * read here, in which case evidence is stated from the report alone.
 */
export async function readNativeCoverage(file) {
  const text = await readBounded(file, MAX_COVERAGE_BYTES);
  try {
    const files = JSON.parse(text ?? "null")?.files;
    if (files === null || typeof files !== "object") return null;
    const coverage = new Map();
    for (const [name, entry] of Object.entries(files)) {
      const lines = new Map();
      for (const [line, hits] of Object.entries(entry?.lines ?? {})) lines.set(Number(line), hits);
      coverage.set(name, lines);
    }
    return coverage;
  } catch {
    return null;
  }
}
