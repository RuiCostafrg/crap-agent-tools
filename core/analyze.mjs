// "Which functions I just changed are riskiest, and what tests are missing?"
// Runs each scanner whose language has files changed since a base commit and
// answers with one ranked, bounded, deterministic list of the changed functions.
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ToolError, checkAbort, cleanText, run } from "./exec.mjs";
import { changedFiles } from "./git.mjs";
import { locateScanner } from "./scanner.mjs";
import { tsCrap } from "./ts-crap.mjs";
import { dotnetCrap } from "./dotnet-crap.mjs";

export const RESULT_SCHEMA = "crap-agent-tools/changed-risk/v2";
/** Scanners in a fixed order: the order of `scanners` in every answer. */
export const ADAPTERS = [tsCrap, dotnetCrap];
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;
export const MAX_RESULT_BYTES = 24 * 1024;
const MAX_FILES = 1000;
const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_LISTED_LINES = 8;
const MAX_SYNTAX_ERRORS = 10;
const SCOPES = ["changed", "files"];

function validCoveragePath(value) {
  return typeof value === "string" && value && value.length <= 500 && !path.isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..") && !/\p{Cc}/u.test(value);
}

function validate(options, adapters) {
  const { root, base = "HEAD", limit = DEFAULT_LIMIT, threshold, coverage, scope = "changed", language = "auto", timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const fail = message => { throw new ToolError("invalid_argument", message); };
  if (typeof root !== "string" || !path.isAbsolute(root)) fail("root must be an absolute path.");
  if (typeof base !== "string" || !base || base.length > 200 || base.startsWith("-") || /[\p{Cc}\s]/u.test(base)) {
    fail("base must be a git ref or commit of at most 200 characters, without spaces and not starting with '-'.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) fail(`limit must be an integer from 1 to ${MAX_LIMIT}.`);
  if (threshold !== undefined && (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0)) {
    fail("threshold must be a finite nonnegative number.");
  }
  const ids = adapters.map(adapter => adapter.id);
  if (coverage !== undefined) {
    const coverageHelp = `coverage must be a path relative to the project root, without '..', or an object mapping ${ids.join(" and ")} to such paths.`;
    if (typeof coverage === "string") {
      if (!validCoveragePath(coverage)) fail(coverageHelp);
    } else if (coverage === null || typeof coverage !== "object" || Array.isArray(coverage) || !Object.keys(coverage).length ||
        Object.entries(coverage).some(([key, value]) => !ids.includes(key) || !validCoveragePath(value))) {
      fail(coverageHelp);
    }
  }
  if (!SCOPES.includes(scope)) fail(`scope must be one of: ${SCOPES.join(", ")}.`);
  if (language !== "auto" && !ids.includes(language)) fail(`language must be one of: auto, ${ids.join(", ")}.`);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) fail("timeoutMs must be from 1000 to 600000.");
  return { root, base, limit, threshold, coverage, scope, language, timeoutMs };
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
  } else if (item.coverageMeasured === false) {
    kind = "no_function_coverage";
    statement = "The coverage data has no points inside this function, so it counts as 0% covered.";
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

const languageName = id => ADAPTERS.find(adapter => adapter.id === id)?.language ?? id;

function scannerError(adapter, result) {
  const message = cleanText(result.stderr.split("\n").find(line => line.trim()) ?? "", 300);
  if (/coverage SHA256 mismatch|source changed since coverage|stale coverage/i.test(message)) {
    return new ToolError("coverage_stale", "The coverage data is older than the source: a changed file no longer matches it.",
      "Collect coverage again after the last edit, then retry.");
  }
  if (/coverage/i.test(message)) {
    return new ToolError("coverage_invalid", `${adapter.name} rejected the coverage data: ${message}`);
  }
  return new ToolError("scanner_failed", `${adapter.name} failed (exit ${result.code}): ${message || "no message"}`);
}

/**
 * Scan `paths` with one scanner. A scanner that stops on the first file it
 * cannot parse (dotnet-crap) is run again without that file, at most
 * MAX_SYNTAX_ERRORS times; those files are reported as syntax errors.
 */
async function scanFiles({ adapter, scanner, root, paths, coverage, threshold, env, signal, timeoutMs }) {
  let remaining = [...paths];
  const unparsable = [];
  for (;;) {
    if (!remaining.length) {
      return { threshold: threshold ?? adapter.defaultThreshold ?? null, failed: false, completenessFailed: true, functions: [], syntaxErrors: unparsable };
    }
    let result;
    try {
      result = await run(scanner.path, adapter.scanArguments({ root, files: remaining, coverage, threshold }),
        { cwd: root, env, signal, timeoutMs, maxStdoutBytes: MAX_REPORT_BYTES });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ToolError("scanner_unusable", `${adapter.name} could not be started (${cleanText(error.code ?? error.message, 80)}).`);
    }
    if (result.timedOut) {
      throw new ToolError("scanner_timeout", `${adapter.name} did not finish within ${Math.round(timeoutMs / 1000)} seconds.`,
        "Use a closer base so fewer files change, or raise the timeout.");
    }
    if (result.overflow) throw new ToolError("scanner_output_too_large", `${adapter.name} wrote a report larger than ${MAX_REPORT_BYTES} bytes.`);
    if (!adapter.hasReport(result.code)) {
      const bad = adapter.syntaxErrorPath(result.stderr);
      if (bad && remaining.includes(bad) && unparsable.length < MAX_SYNTAX_ERRORS) {
        remaining = remaining.filter(file => file !== bad);
        unparsable.push({ path: bad });
        continue;
      }
      throw scannerError(adapter, result);
    }
    const report = adapter.parseReport(result.stdout.toString("utf8"));
    const selected = new Set(remaining);
    if (report.functions.some(item => !selected.has(item.path))) {
      throw new ToolError("invalid_scanner_output", `${adapter.name} reported a function in a file that was not selected.`);
    }
    if (unparsable.length) {
      report.syntaxErrors = [...report.syntaxErrors, ...unparsable];
      report.completenessFailed = true;
    }
    return report;
  }
}

/**
 * Analyse the changes under `root` since merge-base(`base`, HEAD), including
 * uncommitted and untracked files. Never writes files or uses the network.
 *
 * Options: root (absolute), base ("HEAD"), limit (10, max 50), threshold,
 * coverage (native coverage JSON relative to root, or { typescript, csharp }),
 * scope ("changed" | "files"), language ("auto" | "typescript" | "csharp"),
 * scannerPaths ({ typescript, csharp }), allowProjectScanner (false), timeoutMs,
 * env, signal; for tests: adapters, maxBytes.
 * A scanner is located and run only when its language has changed files.
 * Throws ToolError for expected failures; see `toErrorResult`.
 */
export async function analyzeChanges(options = {}) {
  const adapters = options.adapters ?? ADAPTERS;
  const env = options.env ?? process.env;
  const signal = options.signal;
  const maxBytes = options.maxBytes ?? MAX_RESULT_BYTES;
  const { base, limit, threshold, coverage, scope, language, timeoutMs } = validate(options, adapters);
  const root = await projectRoot(options.root);
  checkAbort(signal);

  const inScope = language === "auto" ? adapters : adapters.filter(adapter => adapter.id === language);
  const excludedDirectories = new Map();
  for (const adapter of inScope) excludedDirectories.set(adapter, await adapter.excludedDirectories(root));
  const excluded = new Map(inScope.map(adapter => [adapter, 0]));
  let otherLanguageFiles = 0;
  const ownerOf = file => inScope.find(adapter => adapter.isSource(file));
  const diff = await changedFiles({
    root, base, env, signal,
    select(file) {
      const adapter = ownerOf(file);
      if (!adapter) {
        if (adapters.some(other => other.isSource(file))) otherLanguageFiles++;
        return false;
      }
      if (adapter.selects(file, excludedDirectories.get(adapter))) return true;
      excluded.set(adapter, excluded.get(adapter) + 1);
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
    throw new ToolError("diff_too_large", `${files.length} changed source files exceed the limit of ${MAX_FILES}.`,
      "Use a closer base or analyse a subdirectory.");
  }
  const groups = inScope.map(adapter => ({ adapter, files: files.filter(file => ownerOf(file.path) === adapter) }))
    .filter(group => group.files.length);

  // Coverage: one path serves the only language with changes; an object names each language's file.
  const coverageByLanguage = new Map();
  if (typeof coverage === "string") {
    if (groups.length > 1) {
      throw new ToolError("invalid_argument",
        `coverage names one file, but the changes span ${groups.map(group => group.adapter.language).join(" and ")}.`,
        `Pass coverage as an object, for example {"${groups[0].adapter.id}": "...", "${groups[1].adapter.id}": "..."}.`);
    }
    coverageByLanguage.set((groups[0]?.adapter ?? inScope[0])?.id, coverage);
  } else if (coverage) {
    for (const [id, file] of Object.entries(coverage)) coverageByLanguage.set(id, file);
  }
  const coveragePaths = new Map();
  for (const [id, file] of [...coverageByLanguage].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    coveragePaths.set(id, await coverageFile(root, file));
  }
  checkAbort(signal);

  for (const group of groups) {
    const { adapter } = group;
    try {
      group.scanner = await locateScanner({
        adapter, scannerPath: options.scannerPaths?.[adapter.id], root,
        allowProjectScanner: options.allowProjectScanner, env, signal,
      });
    } catch (error) {
      const others = groups.filter(other => other !== group).map(other => other.adapter.id);
      if (error instanceof ToolError && others.length) {
        throw new ToolError(error.kind, error.message,
          `${error.hint ? `${error.hint} ` : ""}Or pass language: "${others[0]}" to analyse only the ${groups.find(g => g.adapter.id === others[0]).adapter.language} changes.`);
      }
      throw error;
    }
    group.coveragePath = coveragePaths.get(adapter.id);
    group.report = await scanFiles({
      adapter, scanner: group.scanner, root, paths: group.files.map(file => file.path),
      coverage: group.coveragePath, threshold, env, signal, timeoutMs,
    });
    group.coverageMap = group.coveragePath ? await adapter.readCoverage(group.coveragePath) : null;
  }

  const functions = groups.flatMap(group => group.report.functions.map(item => ({ ...item, group })));
  const syntaxErrors = groups.flatMap(group => group.report.syntaxErrors);
  const changed = markChanged(functions, files);
  const fileByPath = new Map(files.map(file => [file.path, file]));
  const isChangedLine = (item) => (line) => {
    const file = fileByPath.get(item.path);
    return !!file && (file.whole || file.ranges.some(([first, last]) => line >= first && line <= last));
  };

  const considered = functions.filter(item => scope === "files" || changed.has(item)).sort(byRisk);
  const ranked = considered.map((item, index) => {
    const evidence = describeEvidence(item, {
      coverageSupplied: item.group.coveragePath !== undefined, coverageMap: item.group.coverageMap,
      threshold: item.group.report.threshold, changedLines: isChangedLine(item), nested: nestedIn(item, functions),
    });
    return {
      rank: index + 1,
      language: item.group.adapter.id,
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

  const changedFunctions = functions.filter(item => changed.has(item));
  const notes = [];
  if (!files.length) notes.push(`No changed ${inScope.map(adapter => adapter.language).join(" or ")} files since the base; nothing to score.`);
  else if (!changedFunctions.length) notes.push("The changed files contain no changed functions (only top-level code, types, comments or deletions changed).");
  for (const group of groups) {
    if (group.coveragePath === undefined) {
      notes.push(`Coverage was not supplied for ${group.adapter.language}: every ${group.adapter.language} score assumes 0% coverage. Pass coverage to see which lines tests miss.`);
    }
  }
  const otherFailing = functions.filter(item => item.failed && !changed.has(item)).length;
  if (otherFailing) notes.push(`${otherFailing} unchanged function(s) in the changed files also fail; a CI gate that scores whole changed files will report them.`);
  for (const [adapter, count] of excluded) {
    if (count) notes.push(`${count} changed ${adapter.language} file(s) are build, dependency or generated paths ${adapter.name} excludes and were not scored.`);
  }
  if (otherLanguageFiles) notes.push(`${otherLanguageFiles} changed file(s) in other languages were not analysed (language: ${language}).`);
  if (skippedFiles) notes.push(`${skippedFiles} changed path(s) are symbolic links or no longer exist and were not scored.`);
  if (syntaxErrors.length) notes.push(`${syntaxErrors.length} changed file(s) do not parse; their functions are missing from this answer.`);

  const answer = {
    schema: RESULT_SCHEMA,
    base, mergeBase: diff.mergeBase.slice(0, 12), scope, language,
    scanners: groups.map(group => ({
      language: group.adapter.id,
      name: group.adapter.name,
      version: group.scanner.version,
      threshold: group.report.threshold,
      changedFiles: group.files.length,
      coverageSupplied: group.coveragePath !== undefined,
      gateFailed: group.report.failed,
      completenessFailed: group.report.completenessFailed,
    })),
    totals: {
      changedFiles: files.length,
      functionsInChangedFiles: functions.length,
      changedFunctions: changedFunctions.length,
      failingChangedFunctions: changedFunctions.filter(item => item.failed).length,
      failingOtherFunctions: otherFailing,
    },
    functions: ranked.slice(0, limit),
    omitted: Math.max(0, ranked.length - limit),
    syntaxErrors: [...syntaxErrors].sort((a, b) => byPathLine({ line: 0, column: 0, name: "", ...a }, { line: 0, column: 0, name: "", ...b }))
      .slice(0, MAX_SYNTAX_ERRORS)
      .map(item => ({ path: cleanText(item.path, 200), ...(item.line ? { line: item.line, column: item.column } : {}) })),
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
  const scanners = answer.scanners.map(s =>
    `${s.name} ${s.version} (${languageName(s.language)}, threshold ${s.threshold ?? "default"}, coverage ${s.coverageSupplied ? "supplied" : "not supplied"})`);
  const lines = [
    `${scanners.length ? scanners.join("; ") : "No scanner ran"}; base ${answer.base} (merge base ${answer.mergeBase}).`,
    `${t.changedFunctions} changed function(s) in ${t.changedFiles} changed file(s); failing the gate: ${t.failingChangedFunctions}. ` +
    `Gate over the whole changed files: ${answer.scanners.some(s => s.gateFailed) ? "FAIL" : "pass"}.`,
  ];
  for (const item of answer.functions) {
    lines.push(`${item.rank}. ${item.failsGate ? "FAIL" : "ok"} ${item.path}:${item.line} ${item.name}${item.changed ? "" : " (unchanged)"}` +
      ` - CRAP ${item.crap}, complexity ${item.complexity}, coverage ${Math.floor(item.coverage * 100)}%. ${item.missing}`);
  }
  for (const item of answer.syntaxErrors) lines.push(`Does not parse: ${item.path}${item.line ? `:${item.line}:${item.column}` : ""}`);
  for (const note of answer.notes) lines.push(`Note: ${note}`);
  return lines.join("\n");
}
