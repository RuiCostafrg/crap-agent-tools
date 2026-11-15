// C# through dotnet-crap: report parsing, the syntax-error retry, exclusions,
// and diffs that mix TypeScript and C#.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { analyzeChanges, formatAnswer } from "../core/analyze.mjs";
import { dotnetReport, fakeScanner, pathWith, realDotnetScanner, realScanner, report, repo, tempDir } from "./helpers.mjs";

const CALC = `namespace Demo;

public class Calc
{
    public int Price(int qty)
    {
        return qty * 10;
    }

    public string Label(int n) => $"#{n}";
}
`;
const CALC_CHANGED = CALC.replace("        return qty * 10;\n",
  "        var total = qty * 10;\n        if (qty > 100) total -= 50;\n        if (qty > 10) total -= 5;\n        if (total < 0) total = 0;\n        return total;\n");

const failsWith = (kind) => (error) => { assert.equal(error.kind, kind, `${error.kind}: ${error.message}`); return true; };
const sha256 = text => createHash("sha256").update(text).digest("hex");

/** A repository with fake ts-crap and fake dotnet-crap on PATH, each with its own report and argument log. */
async function withFakes(files, body) {
  const r = await repo(files);
  const ts = await fakeScanner();
  const cs = await fakeScanner({ name: "dotnet-crap", version: "0.1.0", prefix: "FAKE_DOTNET_" });
  const scratch = await tempDir("crap-agent-scratch-");
  const file = name => path.join(scratch, name);
  const env = (extra = {}) => ({
    ...process.env, PATH: pathWith(ts.bin, cs.bin),
    FAKE_REPORT: file("ts.json"), FAKE_ARGS_LOG: file("ts.log"),
    FAKE_DOTNET_REPORT: file("cs.json"), FAKE_DOTNET_ARGS_LOG: file("cs.log"), ...extra,
  });
  const analyze = (options = {}, extra) => analyzeChanges({ root: r.root, env: env(extra), ...options });
  const calls = async name => (await readFile(file(name), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  try {
    await body({
      r, analyze, env, ts, cs,
      setTs: text => writeFile(file("ts.json"), text),
      setCs: text => writeFile(file("cs.json"), text),
      tsCalls: () => calls("ts.log"),
      csCalls: () => calls("cs.log"),
      clearCalls: () => Promise.all([rm(file("ts.log"), { force: true }), rm(file("cs.log"), { force: true })]),
    });
  } finally {
    await Promise.all([r.cleanup(), ts.cleanup(), cs.cleanup(), rm(scratch, { recursive: true, force: true })]);
  }
}
const scanned = args => args.slice(args.indexOf("--") + 1);

test("dotnet-crap report: gate from the threshold, null coverage, schema checks", () => withFakes({ "src/Calc.cs": CALC }, async ({ r, analyze, setCs }) => {
  await r.write("src/Calc.cs", CALC_CHANGED);
  const rows = [
    { file: "src/Calc.cs", name: "Price", line: 5, end_line: 11, complexity: 4, crap: 20 },
    { file: "src/Calc.cs", name: "Label", line: 13, end_line: 13, complexity: 1, crap: 2 },
  ];
  await setCs(dotnetReport(rows));
  const answer = await analyze({ scope: "files" });
  assert.deepEqual(answer.scanners, [{ language: "csharp", name: "dotnet-crap", version: "0.1.0", threshold: 10, changedFiles: 1,
    coverageSupplied: false, gateFailed: true, completenessFailed: false }]);
  assert.deepEqual(answer.functions.map(f => [f.language, f.name, f.failsGate, f.coverage, f.evidence, f.changed]),
    [["csharp", "Price", true, 0, "not_measured", true], ["csharp", "Label", false, 0, "not_measured", false]]);
  assert.match(answer.functions[0].missing, /needs at least 28% line coverage to pass the threshold 10/);

  // Coverage supplied: null means no points inside the function; a number is used as is.
  await r.write("cov.json", JSON.stringify({ version: 1, files: { "src/Calc.cs": { sha256: "0".repeat(64), lines: { 7: 1, 8: 0, 9: 1, 10: 1 } } } }));
  await setCs(dotnetReport([{ ...rows[0], coverage: 0.75, crap: 4.25 }, rows[1]]));
  const covered = await analyze({ scope: "files", coverage: "cov.json" });
  assert.deepEqual(covered.functions.map(f => [f.name, f.evidence, f.failsGate]), [["Price", "partial", false], ["Label", "no_function_coverage", false]]);
  assert.deepEqual(covered.functions[0].uncoveredLines, [8]);
  assert.match(covered.functions[1].missing, /no points inside this function/);

  for (const bad of [{ file: "../x.cs" }, { coverage: 2 }, { line: 0 }, { end_line: 1 }, { crap: -1 }, { name: 1 }]) {
    await setCs(dotnetReport([{ ...rows[0], ...bad }]));
    await assert.rejects(analyze(), failsWith("invalid_scanner_output"), JSON.stringify(bad));
  }
  await setCs(dotnetReport(rows, { failed: false }));
  await assert.rejects(analyze(), failsWith("invalid_scanner_output"), "failed must agree with the scores");
  for (const text of ["", "[]", '{"threshold":10}']) {
    await setCs(text);
    await assert.rejects(analyze(), failsWith("invalid_scanner_output"));
  }
  await setCs(dotnetReport(rows));
  await assert.rejects(analyze({}, { FAKE_DOTNET_VERSION: "dotnet-crap 0.0.9" }), failsWith("scanner_too_old"));
  await assert.rejects(analyze({}, { FAKE_DOTNET_VERSION: "ts-crap 2.4.0" }), failsWith("scanner_unusable"));
  await assert.rejects(analyze({}, { FAKE_DOTNET_EXIT: "2", FAKE_DOTNET_STDERR: "error: stale coverage for src/Calc.cs" }), failsWith("coverage_stale"));
}));

test("dotnet-crap: a file that does not parse is reported and the rest is rescanned", () => withFakes({ "src/Calc.cs": CALC }, async ({ r, analyze, setCs, csCalls, clearCalls }) => {
  await r.write("src/Calc.cs", CALC_CHANGED);
  await r.write("src/Bad.cs", "class Bad { void M( { }\n");
  await setCs(dotnetReport([{ file: "src/Calc.cs", name: "Price", line: 5, end_line: 11, complexity: 4, crap: 20 }]));
  const answer = await analyze({}, { FAKE_DOTNET_SYNTAX: "src/Bad.cs" });
  assert.deepEqual((await csCalls()).map(scanned), [["src/Bad.cs", "src/Calc.cs"], ["src/Calc.cs"]]);
  assert.deepEqual(answer.syntaxErrors, [{ path: "src/Bad.cs" }]);
  assert.equal(answer.scanners[0].completenessFailed, true);
  assert.deepEqual(answer.functions.map(f => f.name), ["Price"]);
  assert.match(formatAnswer(answer), /^Does not parse: src\/Bad\.cs$/m);

  // The only changed file does not parse: no scan is left to run.
  await clearCalls();
  await r.write("src/Calc.cs", CALC);
  const only = await analyze({}, { FAKE_DOTNET_SYNTAX: "src/Bad.cs" });
  assert.equal((await csCalls()).length, 1);
  assert.deepEqual(only.syntaxErrors, [{ path: "src/Bad.cs" }]);
  assert.equal(only.scanners[0].threshold, 10);

  // A syntax error naming a file that was not selected is a scanner failure, not a retry.
  await assert.rejects(analyze({}, { FAKE_DOTNET_EXIT: "2", FAKE_DOTNET_STDERR: "error: invalid C# syntax in elsewhere.cs" }), failsWith("scanner_failed"));
}));

test("dotnet-crap: build directories and generated files are never passed to the scanner", () => withFakes({ "src/Calc.cs": CALC }, async ({ r, analyze, setCs, csCalls }) => {
  await r.write("src/Calc.cs", CALC_CHANGED);
  for (const name of ["bin/Debug/B.cs", "obj/O.cs", "src/X.g.cs", "src/Form.Designer.cs", "src/Y.generated.cs"]) await r.write(name, "class Z {}\n");
  await setCs(dotnetReport([]));
  const answer = await analyze();
  assert.deepEqual((await csCalls()).map(scanned), [["src/Calc.cs"]]);
  assert.ok(answer.notes.some(note => /^5 changed C# file\(s\) are build, dependency or generated paths dotnet-crap excludes/.test(note)));
}));

test("mixed TypeScript and C#: one ranking, scanners in a fixed order, language filter and coverage routing", () => withFakes(
  { "src/a.ts": "export const a = 1;\n", "src/Calc.cs": CALC },
  async ({ r, analyze, env, ts, setTs, setCs, tsCalls, csCalls, clearCalls }) => {
    await r.write("src/a.ts", "export function a(x: number) {\n  return x > 1 ? x : -x;\n}\n");
    await r.write("src/Calc.cs", CALC_CHANGED);
    await setTs(report([{ path: "src/a.ts", name: "a", line: 1, end_line: 3, complexity: 2, crap: 6 }]));
    await setCs(dotnetReport([{ file: "src/Calc.cs", name: "Price", line: 5, end_line: 11, complexity: 4, crap: 20 }]));
    const answer = await analyze();
    assert.deepEqual(answer.scanners.map(s => [s.language, s.name, s.changedFiles]), [["typescript", "ts-crap", 1], ["csharp", "dotnet-crap", 1]]);
    assert.deepEqual(answer.functions.map(f => [f.rank, f.language, f.name]), [[1, "csharp", "Price"], [2, "typescript", "a"]]);
    assert.equal(answer.totals.changedFiles, 2);
    assert.match(formatAnswer(answer), /^ts-crap 2\.4\.0 \(TypeScript, threshold 10, coverage not supplied\); dotnet-crap 0\.1\.0 \(C#, threshold 10, coverage not supplied\); base HEAD/);
    assert.deepEqual(await analyze(), answer, "repeated runs give identical answers");

    const onlyTs = await analyze({ language: "typescript" });
    assert.deepEqual(onlyTs.functions.map(f => f.name), ["a"]);
    assert.ok(onlyTs.notes.some(note => /1 changed file\(s\) in other languages were not analysed \(language: typescript\)/.test(note)));

    await assert.rejects(analyze({ coverage: "cov.json" }), (error) => error.kind === "invalid_argument" && /span TypeScript and C#/.test(error.message));
    await r.write("ts-cov.json", "{}");
    await r.write("cs-cov.json", "{}");
    await clearCalls();
    await analyze({ coverage: { typescript: "ts-cov.json", csharp: "cs-cov.json" } });
    const coverageOf = args => args[args.indexOf("--coverage") + 1];
    assert.equal(coverageOf((await tsCalls())[0]), path.join(r.root, "ts-cov.json"));
    assert.equal(coverageOf((await csCalls())[0]), path.join(r.root, "cs-cov.json"));
    await clearCalls();
    await analyze({ coverage: { csharp: "cs-cov.json" } });
    assert.ok(!(await tsCalls())[0].includes("--coverage"));
    await assert.rejects(analyze({ coverage: { csharp: "missing.json" } }), failsWith("coverage_not_found"));

    // A missing scanner for one language of a mixed diff: an error that says how to narrow it.
    const tsOnlyPath = { ...env(), PATH: pathWith(ts.bin) };
    const error = await analyzeChanges({ root: r.root, env: tsOnlyPath }).catch(e => e);
    assert.equal(error.kind, "scanner_not_found", `${error.message}`);
    assert.match(error.message, /dotnet-crap was not found/);
    assert.match(error.hint, /language: "typescript"/);
    // Without C# changes, a missing dotnet-crap does not matter.
    await r.write("src/Calc.cs", CALC);
    assert.deepEqual((await analyzeChanges({ root: r.root, env: tsOnlyPath })).scanners.map(s => s.name), ["ts-crap"]);
  }));

// End to end with the real dotnet-crap binary.
const real = { skip: realDotnetScanner ? false : "set DOTNET_CRAP_TEST_BIN or put dotnet-crap on PATH" };

test("real dotnet-crap: uncommitted edit, coverage evidence, stale coverage, unparsable and generated files", real, async () => {
  const r = await repo({ "src/Calc.cs": CALC });
  try {
    const options = { root: r.root, scannerPaths: { csharp: realDotnetScanner }, env: { ...process.env, PATH: pathWith() } };
    await r.write("src/Calc.cs", CALC_CHANGED);
    const bare = await analyzeChanges(options);
    assert.deepEqual(bare.functions.map(f => [f.language, f.name, f.line, f.complexity, f.crap, f.failsGate, f.evidence]),
      [["csharp", "Price", 5, 4, 20, true, "not_measured"]]);
    assert.equal(bare.scanners[0].version.split(".").length, 3);

    // Lines 7-10 hold points; 9 never runs. Label has no points at all.
    await r.write("cov/cs.json", JSON.stringify({ version: 1, files: { "src/Calc.cs": { sha256: sha256(CALC_CHANGED), lines: { 7: 1, 8: 1, 9: 0, 10: 1 } } } }));
    const covered = await analyzeChanges({ ...options, coverage: "cov/cs.json", scope: "files" });
    const byName = Object.fromEntries(covered.functions.map(f => [f.name, f]));
    assert.equal(byName.Price.coverage, 0.75);
    assert.equal(byName.Price.evidence, "partial");
    assert.deepEqual(byName.Price.uncoveredLines, [9]);
    assert.deepEqual(byName.Price.uncoveredChangedLines, [9]);
    assert.equal(byName.Price.failsGate, false);
    assert.equal(byName.Label.evidence, "no_function_coverage");

    await r.write("src/Bad.cs", "class Bad { void M( { }\n");
    await r.write("obj/O.cs", "class O { void M() {} }\n");
    await r.write("src/X.g.cs", "class G { void M() {} }\n");
    const mixed = await analyzeChanges(options);
    assert.deepEqual(mixed.syntaxErrors, [{ path: "src/Bad.cs" }]);
    assert.deepEqual(mixed.functions.map(f => f.name), ["Price"]);
    assert.ok(mixed.notes.some(note => /2 changed C# file\(s\) are build, dependency or generated paths/.test(note)));
    assert.deepEqual(await analyzeChanges(options), mixed, "repeated runs give identical answers");

    await r.write("src/Calc.cs", CALC_CHANGED + "// later edit\n");
    await assert.rejects(analyzeChanges({ ...options, coverage: "cov/cs.json" }), failsWith("coverage_stale"));
  } finally { await r.cleanup(); }
});

test("real ts-crap and dotnet-crap together on one branch", { skip: realDotnetScanner && realScanner ? false : "needs both real scanners" }, async () => {
  const r = await repo({ "src/a.ts": "export const a = 1;\n", "src/Calc.cs": CALC });
  try {
    r.git("checkout", "-q", "-b", "feature");
    await r.write("src/a.ts", "export function a(x: number) {\n  if (x > 1) return x;\n  return -x;\n}\n");
    await r.write("src/Calc.cs", CALC_CHANGED);
    r.commit();
    const answer = await analyzeChanges({ root: r.root, base: "main", scannerPaths: { typescript: realScanner, csharp: realDotnetScanner },
      env: { ...process.env, PATH: pathWith() } });
    assert.deepEqual(answer.scanners.map(s => s.name), ["ts-crap", "dotnet-crap"]);
    assert.deepEqual(answer.functions.map(f => [f.language, f.name, f.crap]), [["csharp", "Price", 20], ["typescript", "a", 6]]);
  } finally { await r.cleanup(); }
});
