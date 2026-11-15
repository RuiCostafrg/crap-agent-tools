// Scanner adapter for dotnet-crap (https://github.com/RuiCostafrg/dotnet-crap),
// the C# counterpart of ts-crap. Same object shape as ts-crap.mjs. Behaviour
// below was checked against dotnet-crap 0.1.0:
//   - report: { threshold, files_scanned, coverage_complete, functions[], failed }
//     with no version field and no per-function gate result (fails: crap > threshold);
//   - per-function coverage is null when no coverage point lies inside it;
//   - bin/, obj/, .git/ and *.g.cs, *.generated.cs, *.designer.cs are skipped silently;
//   - invalid C# stops the whole scan: exit 2, "error: invalid C# syntax in PATH";
//   - no project configuration file; the threshold defaults to 10.
import { invalidReport, isCount, isLine, isPath, isScore, parseObject, readNativeCoverage } from "./adapter-util.mjs";

const SOURCE = /\.cs$/i;
const GENERATED = /\.(?:g|generated|designer)\.cs$/i;
const EXCLUDED = ["bin", "obj", ".git"];
const DEFAULT_THRESHOLD = 10;
const invalid = reason => invalidReport("dotnet-crap", reason);

export const dotnetCrap = {
  id: "csharp",
  name: "dotnet-crap",
  command: "dotnet-crap",
  language: "C#",
  minimumVersion: [0, 1, 0],
  versionArguments: ["--version"],

  installHint: "Put a dotnet-crap release binary on PATH or set CRAP_AGENT_DOTNET_CRAP: https://github.com/RuiCostafrg/dotnet-crap/releases",

  /** No project-local binary layout is supported yet. */
  projectBinaries: () => [],

  parseVersion(text) {
    const match = /^dotnet-crap (\d+)\.(\d+)\.(\d+)/.exec(text);
    return match ? match.slice(1).map(Number) : null;
  },

  async excludedDirectories() { return EXCLUDED; },

  isSource: file => SOURCE.test(file),

  /** Generated files and build directories are excluded, as the scanner would skip them. */
  selects(file, excludedDirectories) {
    if (!SOURCE.test(file) || GENERATED.test(file)) return false;
    return !file.split("/").slice(0, -1).some(part => excludedDirectories.includes(part));
  },

  scanArguments({ root, files, coverage, threshold }) {
    return ["--root", root, "--format", "json",
      ...(coverage ? ["--coverage", coverage] : []),
      ...(threshold === undefined ? [] : ["--threshold", String(threshold)]),
      "--", ...files];
  },

  defaultThreshold: DEFAULT_THRESHOLD,

  // Exit 0: gate passed. Exit 1: gate failed, report still written. Exit 2: no report.
  hasReport: code => code === 0 || code === 1,

  /** Validate a JSON report and return the fields this tool uses, in ts-crap's terms. */
  parseReport(text) {
    const report = parseObject("dotnet-crap", text);
    if (!isScore(report.threshold)) throw invalid("threshold must be a finite nonnegative number");
    if (typeof report.failed !== "boolean") throw invalid("failed must be a boolean");
    if (typeof report.coverage_complete !== "boolean") throw invalid("coverage_complete must be a boolean");
    if (!isCount(report.files_scanned)) throw invalid("files_scanned must be a nonnegative integer");
    if (!Array.isArray(report.functions)) throw invalid("functions must be an array");
    const functions = report.functions.map((item, index) => {
      const at = `functions[${index}]`;
      if (item === null || typeof item !== "object") throw invalid(`${at} must be an object`);
      if (!isPath(item.file)) throw invalid(`${at}.file must be a root-relative path`);
      if (typeof item.name !== "string") throw invalid(`${at}.name must be a string`);
      for (const key of ["line", "column", "end_line", "complexity"]) {
        if (!isLine(item[key])) throw invalid(`${at}.${key} must be a positive integer`);
      }
      if (item.end_line < item.line) throw invalid(`${at}.end_line is before its line`);
      if (item.coverage !== null && (!isScore(item.coverage) || item.coverage > 1)) throw invalid(`${at}.coverage must be null or a number from 0 to 1`);
      if (!isScore(item.crap)) throw invalid(`${at}.crap must be a finite nonnegative number`);
      return {
        path: item.file, name: item.name, line: item.line, column: item.column, endLine: item.end_line,
        complexity: item.complexity, coverage: item.coverage ?? 0, coverageMeasured: item.coverage !== null,
        crap: item.crap, failed: item.crap > report.threshold,
      };
    });
    if (report.failed !== functions.some(item => item.failed)) throw invalid("failed does not match the scores and threshold");
    return { threshold: report.threshold, failed: report.failed, completenessFailed: false, functions, syntaxErrors: [] };
  },

  readCoverage: readNativeCoverage,

  /** The root-relative file that stopped a scan with a syntax error, or null. */
  syntaxErrorPath(stderr) {
    const match = /^error: invalid C# syntax in (.+)$/m.exec(stderr);
    return match ? match[1] : null;
  },
};
