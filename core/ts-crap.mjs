// Scanner adapter for ts-crap (https://github.com/RuiCostafrg/typescript-crap).
// Everything specific to one scanner lives here: which files it accepts, how it
// is invoked, and how its JSON report and coverage input are read. A second
// scanner with the same report roles is another object of this shape.
import { open } from "node:fs/promises";
import path from "node:path";
import { ToolError } from "./exec.mjs";

const SOURCE = /\.(?:ts|tsx|mts|cts)$/;
const DECLARATION = /\.d\.(?:ts|mts|cts)$/;
const DEFAULT_EXCLUDED = ["node_modules", ".git", "target", "dist", "build", "coverage"];
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_COVERAGE_BYTES = 64 * 1024 * 1024;

/** Read a whole regular file, or null when it is missing, too large or unreadable. */
async function readBounded(file, maxBytes) {
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

function invalid(reason) {
  return new ToolError("invalid_scanner_output", `ts-crap produced a report this tool cannot trust: ${reason}.`);
}

const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isLine = value => Number.isSafeInteger(value) && value >= 1;
const isScore = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
// Root-relative slash path, as the report schema defines it.
const isPath = value => typeof value === "string" && value.length > 0 && !/[\\:]/.test(value) &&
  !value.split("/").some(part => part === "" || part === "." || part === "..");

export const tsCrap = {
  name: "ts-crap",
  command: "ts-crap",
  language: "TypeScript",
  minimumVersion: [2, 4, 0], // --on-syntax-error report
  versionArguments: ["--version"],

  installHint: "Install it with `npm install --save-dev --save-exact typescript-crap` (then allow the project scanner) " +
    "or put a release binary on PATH: https://github.com/RuiCostafrg/typescript-crap#install",

  /**
   * The native binary of the npm platform package, bypassing the Node launcher
   * (which refuses to run on unlisted platforms such as Android). Android runs
   * the static musl Linux build.
   */
  projectBinaries(root, platform = process.platform, arch = process.arch) {
    const os = platform === "android" ? "linux" : platform;
    if (!["linux", "darwin", "win32"].includes(os) || !["x64", "arm64"].includes(arch)) return [];
    const file = os === "win32" ? "ts-crap.exe" : "ts-crap";
    return [path.join(root, "node_modules", `typescript-crap-${os}-${arch}`, "bin", file)];
  },

  parseVersion(text) {
    const match = /^ts-crap (\d+)\.(\d+)\.(\d+)/.exec(text);
    return match ? match.slice(1).map(Number) : null;
  },

  /** Directory names the scanner refuses to scan; explicit files inside them are errors. */
  async excludedDirectories(root) {
    const text = await readBounded(path.join(root, "ts-crap.json"), MAX_CONFIG_BYTES);
    try {
      const configured = JSON.parse(text ?? "null")?.excluded_directories;
      if (Array.isArray(configured) && configured.every(name => typeof name === "string")) return configured;
    } catch { /* ts-crap reports an invalid config itself */ }
    return DEFAULT_EXCLUDED;
  },

  selects(file, excludedDirectories) {
    if (!SOURCE.test(file) || DECLARATION.test(file)) return false;
    return !file.split("/").slice(0, -1).some(part => excludedDirectories.includes(part));
  },

  scanArguments({ root, files, coverage, threshold }) {
    return ["--root", root, "--format", "json", "--on-syntax-error", "report",
      ...(coverage ? ["--coverage", coverage] : []),
      ...(threshold === undefined ? [] : ["--threshold", String(threshold)]),
      "--", ...files];
  },

  // Exit 0: gate passed. Exit 1: gate failed, report still written. Anything else: no report.
  hasReport: code => code === 0 || code === 1,

  /** Validate a JSON report (schema report-v1) and return only the fields this tool uses. */
  parseReport(text) {
    let report;
    try { report = JSON.parse(text); } catch { throw invalid("the output is not valid JSON"); }
    if (report === null || typeof report !== "object" || Array.isArray(report)) throw invalid("the report is not a JSON object");
    if (report.version !== 1) {
      throw new ToolError("unsupported_report_version",
        `ts-crap wrote report version ${JSON.stringify(report.version) ?? "undefined"}; this tool reads version 1 only.`,
        "Update this tool, or use a ts-crap release that writes report version 1.");
    }
    if (!isScore(report.threshold)) throw invalid("threshold must be a finite nonnegative number");
    for (const key of ["failed", "completeness_failed"]) {
      if (typeof report[key] !== "boolean") throw invalid(`${key} must be a boolean`);
    }
    for (const key of ["files_scanned", "files_missing_coverage", "functions_missing_coverage"]) {
      if (!isCount(report[key])) throw invalid(`${key} must be a nonnegative integer`);
    }
    if (!Array.isArray(report.functions)) throw invalid("functions must be an array");
    const functions = report.functions.map((item, index) => {
      const at = `functions[${index}]`;
      if (item === null || typeof item !== "object") throw invalid(`${at} must be an object`);
      if (!isPath(item.path)) throw invalid(`${at}.path must be a root-relative path`);
      if (typeof item.name !== "string") throw invalid(`${at}.name must be a string`);
      for (const key of ["line", "column", "end_line", "complexity"]) {
        if (!isLine(item[key])) throw invalid(`${at}.${key} must be a positive integer`);
      }
      if (item.end_line < item.line) throw invalid(`${at}.end_line is before its line`);
      if (!isScore(item.coverage) || item.coverage > 1) throw invalid(`${at}.coverage must be a number from 0 to 1`);
      if (!isScore(item.crap)) throw invalid(`${at}.crap must be a finite nonnegative number`);
      if (typeof item.failed !== "boolean") throw invalid(`${at}.failed must be a boolean`);
      return {
        path: item.path, name: item.name, line: item.line, column: item.column, endLine: item.end_line,
        complexity: item.complexity, coverage: item.coverage, crap: item.crap, failed: item.failed,
      };
    });
    const listed = report.syntax_errors ?? [];
    if (!Array.isArray(listed)) throw invalid("syntax_errors must be an array");
    const syntaxErrors = listed.map((item, index) => {
      const at = `syntax_errors[${index}]`;
      if (item === null || typeof item !== "object") throw invalid(`${at} must be an object`);
      if (typeof item.path !== "string" || !item.path) throw invalid(`${at}.path must be a string`);
      if (!isLine(item.line) || !isLine(item.column)) throw invalid(`${at} must have a positive line and column`);
      return { path: item.path, line: item.line, column: item.column };
    });
    return { threshold: report.threshold, failed: report.failed, completenessFailed: report.completeness_failed, functions, syntaxErrors };
  },

  /**
   * Line hits from a native coverage file (schema coverage-v1) that the scanner
   * has already accepted: Map of path to Map of line to hits. Null when the file
   * cannot be read here, in which case evidence is stated from the report alone.
   */
  async readCoverage(file) {
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
  },
};
