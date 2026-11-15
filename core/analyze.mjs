// "Which functions I just changed are riskiest, and what tests are missing?"
// Runs the scanner on the files changed since a base commit and answers with a
// ranked, bounded, deterministic list of the changed functions.
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ToolError, checkAbort, cleanText, run } from "./exec.mjs";
import { changedFiles } from "./git.mjs";
import { locateScanner } from "./scanner.mjs";
import { tsCrap } from "./ts-crap.mjs";

export const RESULT_SCHEMA = "crap-agent-tools/changed-risk/v1";
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;
export const MAX_RESULT_BYTES = 24 * 1024;
const MAX_FILES = 1000;
const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_LISTED_LINES = 8;
const MAX_SYNTAX_ERRORS = 10;
const SCOPES = ["changed", "files"];

function validate(options) {
  const { root, base = "HEAD", limit = DEFAULT_LIMIT, threshold, coverage, scope = "changed", timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const fail = message => { throw new ToolError("invalid_argument", message); };
  if (typeof root !== "string" || !path.isAbsolute(root)) fail("root must be an absolute path.");
  if (typeof base !== "string" || !base || base.length > 200 || base.startsWith("-") || /[\p{Cc}\s]/u.test(base)) {
    fail("base must be a git ref or commit of at most 200 characters, without spaces and not starting with '-'.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) fail(`limit must be an integer from 1 to ${MAX_LIMIT}.`);
  if (threshold !== undefined && (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0)) {
    fail("threshold must be a finite nonnegative number.");
  }
  if (coverage !== undefined) {
    if (typeof coverage !== "string" || !coverage || coverage.length > 500 || path.isAbsolute(coverage) ||
        coverage.split(/[\\/]/).includes("..") || /\p{Cc}/u.test(coverage)) {
      fail("coverage must be a path relative to the project root, without '..'.");
    }
  }
  if (!SCOPES.includes(scope)) fail(`scope must be one of: ${SCOPES.join(", ")}.`);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) fail("timeoutMs must be from 1000 to 600000.");
  return { root, base, limit, threshold, coverage, scope, timeoutMs };
}

async function projectRoot(root) {
  try {
    const resolved = await realpath(root);
    if ((await stat(resolved)).isDirectory()) return resolved;
  } catch { /* reported below */ }
  throw new ToolError("invalid_argument", "root must be an existing directory.");
}

async function coverageFile(root, coverage) {
  const file = path.join(root, coverage);
  try {
    const info = await lstat(file);
    if (info.isFile()) return file;
  } catch { /* reported below */ }
  throw new ToolError("coverage_not_found", `The coverage file ${JSON.stringify(cleanText(coverage, 200))} is not a regular file under the project root.`,
    "Pass the native coverage JSON written by the ts-crap coverage helpers, relative to the project root.");
}

/** Mark each function that owns a changed line: the innermost function containing it. */
function markChanged(functions, files) {
  const byPath = new Map();
  for (const item of functions) {
    if (!byPath.has(item.path)) byPath.set(item.path, []);
    byPath.get(item.path).push(item);
  }
  const changed = new Set();
  for (const file of files) {
    const own = byPath.get(file.path) ?? [];
    if (file.whole) { for (const item of own) changed.add(item); continue; }
    const owner = (contains) => {
      const candidates = own.filter(contains);
      if (!candidates.length) return;
      const span = Math.min(...candidates.map(item => item.endLine - item.line));
      for (const item of candidates) if (item.endLine - item.line === span) changed.add(item);
    };
    for (const [first, last] of file.ranges) {
      for (let line = first; line <= last; line++) owner(item => item.line <= line && line <= item.endLine);
    }
    // A pure deletion after new-side line `after` is inside a function when lines follow it there.
    for (const after of file.deletions) owner(item => item.line <= after && after < item.endLine);
  }
  return changed;
}

/** Lines of `item` that are not inside a function nested in it. */
function ownsLine(item, nested, line) {
  return line >= item.line && line <= item.endLine && !nested.some(inner => line >= inner.line && line <= inner.endLine);
}

function nestedIn(item, all) {
  return all.filter(other => other !== item && other.path === item.path &&
    other.line >= item.line && other.endLine <= item.endLine &&
    (other.line > item.line || other.endLine < item.endLine || other.column > item.column));
}

/** Smallest whole-percent line coverage at which the score is at or under the threshold, or null if none. */
export function coverageToPass(complexity, threshold) {
  if (complexity > threshold) return null;
  const needed = 1 - Math.cbrt((threshold - complexity) / (complexity * complexity));
  return Math.min(100, Math.max(0, Math.ceil(needed * 100 - 1e-9)));
}

const percent = fraction => `${Math.floor(fraction * 100)}%`;
const listLines = lines => lines.length > MAX_LISTED_LINES
  ? `${lines.slice(0, MAX_LISTED_LINES).join(", ")} and ${lines.length - MAX_LISTED_LINES} more`
  : lines.join(", ");

/** What evidence is missing for one function, as a kind and a plain sentence. */
function describeEvidence(item, { coverageSupplied, coverageMap, changedLines, nested, threshold }) {
  const extra = {};
  let kind, statement;
  const fileLines = coverageMap?.get(item.path);
  if (!coverageSupplied) {
    kind = "not_measured";
    statement = "No coverage data was supplied, so coverage counts as 0%; this score is the worst case.";
  } else if (coverageMap && !fileLines) {
    kind = "no_file_coverage";
    statement = "The coverage data has no entry for this file: no test loaded it.";
  } else if (item.coverage === 0) {
    kind = "uncovered";
    statement = "No test executes this function.";
  } else if (item.coverage < 1) {
    kind = "partial";
    statement = `Tests execute ${percent(item.coverage)} of its lines.`;
    if (fileLines) {
      const zero = [...fileLines].filter(([line, hits]) => hits === 0 && ownsLine(item, nested, line)).map(([line]) => line).sort((a, b) => a - b);
      const zeroChanged = zero.filter(line => changedLines(line));
      if (zero.length) statement += ` Lines never executed: ${listLines(zero)}.`;
      if (zeroChanged.length) {
        statement += ` ${zeroChanged.length === zero.length ? "All" : zeroChanged.length} of them changed in this diff.`;
        extra.uncoveredChangedLines = zeroChanged.slice(0, MAX_LISTED_LINES);
      }
      extra.uncoveredLines = zero.slice(0, MAX_LISTED_LINES);
    }
  } else {
    kind = "covered";
    statement = "Every line runs under test (line coverage; branches are not measured).";
  }
  if (item.complexity > threshold) {
    statement += ` Complexity ${item.complexity} alone exceeds the threshold ${threshold}: more tests cannot make it pass; split the function.`;
  } else if (item.failed) {
    const needed = coverageToPass(item.complexity, threshold);
    statement += ` It needs at least ${needed}% line coverage to pass the threshold ${threshold}.`;
  }
  return { kind, statement, ...extra };
}

const byPathLine = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line || a.column - b.column ||
  (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const byRisk = (a, b) => Number(b.failed) - Number(a.failed) || b.crap - a.crap || b.complexity - a.complexity || byPathLine(a, b);
const round = (value, places) => Number(value.toFixed(places));
const bytes = value => Buffer.byteLength(JSON.stringify(value));

function scannerError(adapter, result) {
  const message = cleanText(result.stderr.split("\n").find(line => line.trim()) ?? "", 300);
  if (/coverage SHA256 mismatch|source changed since coverage/i.test(message)) {
    return new ToolError("coverage_stale", "The coverage data is older than the source: a changed file no longer matches it.",
      "Collect coverage again after the last edit, then retry.");
  }
  if (/coverage/i.test(message)) {
    return new ToolError("coverage_invalid", `${adapter.name} rejected the coverage data: ${message}`);
  }
  return new ToolError("scanner_failed", `${adapter.name} failed (exit ${result.code}): ${message || "no message"}`);
}

/**
 * Analyse the changes under `root` since merge-base(`base`, HEAD), including
 * uncommitted and untracked files. Never writes files or uses the network.
 *
 * Options: root (absolute), base ("HEAD"), limit (10, max 50), threshold,
 * coverage (native coverage JSON relative to root), scope ("changed" | "files"),
 * scannerPath, allowProjectScanner (false), timeoutMs, env, signal.
 * Throws ToolError for expected failures; see `toErrorResult`.
 */
export async function analyzeChanges(options = {}) {
  const adapter = options.adapter ?? tsCrap;
  const env = options.env ?? process.env;
  const signal = options.signal;
  const maxBytes = options.maxBytes ?? MAX_RESULT_BYTES;
  const { base, limit, threshold, coverage, scope, timeoutMs } = validate(options);
  const root = await projectRoot(options.root);
  checkAbort(signal);

  const scanner = await locateScanner({ adapter, scannerPath: options.scannerPath, root, allowProjectScanner: options.allowProjectScanner, env, signal });
  const excludedDirectories = await adapter.excludedDirectories(root);
  let excludedFiles = 0;
  const diff = await changedFiles({
    root, base, env, signal,
    select(file) {
      if (adapter.selects(file, [])) {
        if (adapter.selects(file, excludedDirectories)) return true;
        excludedFiles++;
      }
      return false;
    },
  });
  const files = [];
  let skippedFiles = 0;
  for (const file of diff.files) {
    try {
      if ((await lstat(path.join(root, file.path))).isFile()) { files.push(file); continue; }
    } catch { /* missing from the working tree */ }
    skippedFiles++;
  }
  if (files.length > MAX_FILES) {
    throw new ToolError("diff_too_large", `${files.length} changed ${adapter.language} files exceed the limit of ${MAX_FILES}.`,
      "Use a closer base or analyse a subdirectory.");
  }
  const coveragePath = coverage === undefined ? undefined : await coverageFile(root, coverage);
  checkAbort(signal);

  let report = { threshold: threshold ?? null, failed: false, completenessFailed: false, functions: [], syntaxErrors: [] };
  if (files.length) {
    const args = adapter.scanArguments({ root, files: files.map(file => file.path), coverage: coveragePath, threshold });
    let result;
    try {
      result = await run(scanner.path, args, { cwd: root, env, signal, timeoutMs, maxStdoutBytes: MAX_REPORT_BYTES });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ToolError("scanner_unusable", `${adapter.name} could not be started (${cleanText(error.code ?? error.message, 80)}).`);
    }
    if (result.timedOut) {
      throw new ToolError("scanner_timeout", `${adapter.name} did not finish within ${Math.round(timeoutMs / 1000)} seconds.`,
        "Use a closer base so fewer files change, or raise the timeout.");
    }
    if (result.overflow) throw new ToolError("scanner_output_too_large", `${adapter.name} wrote a report larger than ${MAX_REPORT_BYTES} bytes.`);
    if (!adapter.hasReport(result.code)) throw scannerError(adapter, result);
    report = adapter.parseReport(result.stdout.toString("utf8"));
    const selected = new Set(files.map(file => file.path));
    const stray = report.functions.find(item => !selected.has(item.path));
    if (stray) throw new ToolError("invalid_scanner_output", `${adapter.name} reported a function in a file that was not selected.`);
  }
  const effectiveThreshold = report.threshold;
  const coverageMap = coveragePath ? await adapter.readCoverage(coveragePath) : null;
  const changed = markChanged(report.functions, files);
  const fileByPath = new Map(files.map(file => [file.path, file]));
  const isChangedLine = (item) => (line) => {
    const file = fileByPath.get(item.path);
    return !!file && (file.whole || file.ranges.some(([first, last]) => line >= first && line <= last));
  };

  const considered = report.functions.filter(item => scope === "files" || changed.has(item)).sort(byRisk);
  const ranked = considered.map((item, index) => {
    const evidence = describeEvidence(item, {
      coverageSupplied: coveragePath !== undefined, coverageMap, threshold: effectiveThreshold,
      changedLines: isChangedLine(item), nested: nestedIn(item, report.functions),
    });
    return {
      rank: index + 1,
      path: cleanText(item.path, 200),
      line: item.line,
      endLine: item.endLine,
      name: cleanText(item.name, 120),
      changed: changed.has(item),
      complexity: item.complexity,
      coverage: round(item.coverage, 3),
      crap: round(item.crap, 2),
      failsGate: item.failed,
      evidence: evidence.kind,
      missing: evidence.statement,
      ...(evidence.uncoveredChangedLines ? { uncoveredChangedLines: evidence.uncoveredChangedLines } : {}),
      ...(evidence.uncoveredLines ? { uncoveredLines: evidence.uncoveredLines } : {}),
    };
  });

  const changedFunctions = report.functions.filter(item => changed.has(item));
  const notes = [];
  if (!files.length) notes.push(`No changed ${adapter.language} files since the base; nothing to score.`);
  else if (!changedFunctions.length) notes.push("The changed files contain no changed functions (only top-level code, types, comments or deletions changed).");
  if (coveragePath === undefined && files.length) notes.push("Coverage was not supplied: every score assumes 0% coverage. Pass coverage to see which lines tests miss.");
  const otherFailing = report.functions.filter(item => item.failed && !changed.has(item)).length;
  if (otherFailing) notes.push(`${otherFailing} unchanged function(s) in the changed files also fail; a CI gate that scores whole changed files will report them.`);
  if (excludedFiles) notes.push(`${excludedFiles} changed file(s) are in directories ${adapter.name} excludes and were not scored.`);
  if (skippedFiles) notes.push(`${skippedFiles} changed path(s) are symbolic links or no longer exist and were not scored.`);
  if (report.syntaxErrors.length) notes.push(`${report.syntaxErrors.length} changed file(s) do not parse; their functions are missing from this answer.`);

  const answer = {
    schema: RESULT_SCHEMA,
    scanner: { name: adapter.name, version: scanner.version },
    base, mergeBase: diff.mergeBase.slice(0, 12), scope,
    threshold: effectiveThreshold,
    gate: { failed: report.failed, completenessFailed: report.completenessFailed },
    totals: {
      changedFiles: files.length,
      functionsInChangedFiles: report.functions.length,
      changedFunctions: changedFunctions.length,
      failingChangedFunctions: changedFunctions.filter(item => item.failed).length,
      failingOtherFunctions: otherFailing,
    },
    coverageSupplied: coveragePath !== undefined,
    functions: ranked.slice(0, limit),
    omitted: Math.max(0, ranked.length - limit),
    syntaxErrors: [...report.syntaxErrors].sort(byPathLine).slice(0, MAX_SYNTAX_ERRORS)
      .map(item => ({ path: cleanText(item.path, 200), line: item.line, column: item.column })),
    notes,
  };
  // The byte bound: drop the lowest-ranked rows until the whole answer fits.
  while (answer.functions.length && bytes(answer) > maxBytes) {
    answer.functions.pop();
    answer.omitted++;
  }
  if (answer.omitted) answer.notes.push(`${answer.omitted} lower-ranked function(s) omitted; raise limit or narrow the diff to see them.`);
  return answer;
}

/** Structured form of a failure, for surfaces that return errors as data. */
export function toErrorResult(error) {
  if (error instanceof ToolError) {
    return { schema: RESULT_SCHEMA, error: { kind: error.kind, message: cleanText(error.message, 500), ...(error.hint ? { hint: cleanText(error.hint, 300) } : {}) } };
  }
  if (/cancelled/i.test(error?.message ?? "")) return { schema: RESULT_SCHEMA, error: { kind: "cancelled", message: "Operation cancelled." } };
  return { schema: RESULT_SCHEMA, error: { kind: "internal_error", message: cleanText(error?.message ?? String(error), 500) } };
}

/** Short plain-text rendering of a result (or error result) for a model's context. */
export function formatAnswer(answer) {
  if (answer.error) {
    return `Error (${answer.error.kind}): ${answer.error.message}${answer.error.hint ? `\nHint: ${answer.error.hint}` : ""}`;
  }
  const t = answer.totals;
  const lines = [
    `${answer.scanner.name} ${answer.scanner.version}; base ${answer.base} (merge base ${answer.mergeBase}); threshold ${answer.threshold ?? "default"}; ` +
    `coverage ${answer.coverageSupplied ? "supplied" : "not supplied"}.`,
    `${t.changedFunctions} changed function(s) in ${t.changedFiles} changed file(s); failing the gate: ${t.failingChangedFunctions}. ` +
    `Gate over the whole changed files: ${answer.gate.failed ? "FAIL" : "pass"}.`,
  ];
  for (const item of answer.functions) {
    lines.push(`${item.rank}. ${item.failsGate ? "FAIL" : "ok"} ${item.path}:${item.line} ${item.name}${item.changed ? "" : " (unchanged)"}` +
      ` - CRAP ${item.crap}, complexity ${item.complexity}, coverage ${Math.floor(item.coverage * 100)}%. ${item.missing}`);
  }
  for (const item of answer.syntaxErrors) lines.push(`Does not parse: ${item.path}:${item.line}:${item.column}`);
  for (const note of answer.notes) lines.push(`Note: ${note}`);
  return lines.join("\n");
}
