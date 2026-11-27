import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, executeTool, needsApproval, isReadOnly, truncate, MAX_OUTPUT } from "../dist/core/tools.js";
import { resolveInWorkspace, relative, normalize, isInside } from "../dist/core/paths.js";
import {
  globMatch,
  parseFrontmatter,
  fmStr,
  fmList,
  parseHooks,
  hooksFor,
  applicableInstructions,
  loadCustomizations,
  toolAllowed,
} from "../dist/core/customize.js";
import { diffStats, hunks } from "../dist/core/diff.js";
import { memoryHost } from "./_helpers.mjs";

test("edit_file: exact unique match replaces once", () => {
  assert.equal(applyEdit("a\nb\nc\n", "b\n", "B\n"), "a\nB\nc\n");
});

test("edit_file: not found / ambiguous / empty old_str", () => {
  assert.throws(() => applyEdit("abc", "x", "y"), /old_str was not found/);
  assert.throws(() => applyEdit("x x", "x", "y"), /old_str matches 2 places/);
  assert.throws(() => applyEdit("abc", "", "y"), /must not be empty/);
});

test("edit_file: whitespace must match exactly", () => {
  assert.throws(() => applyEdit("  foo()\n", "foo()  ", "bar()"), /not found/);
});

test("edit_file: CRLF files accept LF snippets and keep CRLF", () => {
  const out = applyEdit("one\r\ntwo\r\nthree\r\n", "two\nthree", "2\n3");
  assert.equal(out, "one\r\n2\r\n3\r\n");
});

test("edit_file: replacement with $ patterns is literal", () => {
  assert.equal(applyEdit("price", "price", "$& $1 $$"), "$& $1 $$");
});

test("edit_file via executeTool reports a file change", async () => {
  const host = memoryHost({ "src/a.ts": "const a = 1;\n" });
  const r = await executeTool(host, "edit_file", { path: "src/a.ts", old_str: "1", new_str: "2" });
  assert.equal(r.output, "Edited src/a.ts");
  assert.deepEqual(r.change, { path: "/ws/src/a.ts", relPath: "src/a.ts", before: "const a = 1;\n", after: "const a = 2;\n" });
  assert.equal(host.store.get("/ws/src/a.ts"), "const a = 2;\n");
});

test("read_file numbers lines and pages", async () => {
  const host = memoryHost({ "f.txt": "a\nb\nc\n" });
  const r = await executeTool(host, "read_file", { path: "f.txt", start_line: 2, end_line: 2 });
  assert.equal(r.output, "    2\tb\n... [1 more lines; total 3. Use start_line/end_line to read more]\n");
  assert.equal((await executeTool(memoryHost({ "e.txt": "" }), "read_file", { path: "e.txt" })).output, "(empty file)");
});

test("write_file creates and overwrites", async () => {
  const host = memoryHost({});
  const r = await executeTool(host, "write_file", { path: "new/x.md", content: "hi\nthere\n" });
  assert.equal(r.output, "Created new/x.md (2 lines)");
  assert.equal(r.change.before, null);
  const r2 = await executeTool(host, "write_file", { path: "new/x.md", content: "bye" });
  assert.equal(r2.output, "Overwrote new/x.md (1 lines)");
  assert.equal(r2.change.before, "hi\nthere\n");
});

test("run_command formats exit code and stderr", async () => {
  const host = memoryHost({}, { runCommand: async () => ({ code: 3, stdout: "out\n", stderr: "bad\n" }) });
  const r = await executeTool(host, "run_command", { command: "x", timeout_secs: 5000 });
  assert.equal(r.output, "Exit code: 3\nout\n\n[stderr]\nbad\n");
  assert.equal(host.commands[0].timeoutMs, 600_000);
  assert.equal(host.commands[0].cwd, "/ws");
});

test("run_command timeout is an error", async () => {
  const host = memoryHost({}, { runCommand: async () => ({ code: -1, stdout: "", stderr: "", timedOut: true }) });
  await assert.rejects(executeTool(host, "run_command", { command: "sleep", timeout_secs: 1 }), /timed out after 1s/);
});

test("output is truncated", () => {
  const t = truncate("x".repeat(MAX_OUTPUT + 10));
  assert.ok(t.endsWith("... [output truncated]"));
  assert.equal(t.length, MAX_OUTPUT + "\n... [output truncated]".length);
});

test("path confinement: refuses paths outside the workspace", () => {
  assert.equal(resolveInWorkspace("/home/me/proj", "src/a.ts"), "/home/me/proj/src/a.ts");
  assert.equal(resolveInWorkspace("/home/me/proj", "./src/../b.ts"), "/home/me/proj/b.ts");
  assert.equal(resolveInWorkspace("/home/me/proj", "/home/me/proj/c"), "/home/me/proj/c");
  assert.equal(resolveInWorkspace("/home/me/proj", "."), "/home/me/proj");
  for (const bad of ["../x", "/etc/passwd", "src/../../x", "/home/me/proj2/a", "/home/me/projX"]) {
    assert.throws(() => resolveInWorkspace("/home/me/proj", bad), /outside the workspace/, bad);
  }
});

test("path confinement: Windows paths and case", () => {
  assert.equal(resolveInWorkspace("C:/Users/me/proj", "src\\a.ts", true), "C:/Users/me/proj/src/a.ts");
  assert.equal(resolveInWorkspace("C:/Users/me/proj", "c:\\users\\ME\\proj\\x.txt", true), "C:/users/ME/proj/x.txt");
  assert.throws(() => resolveInWorkspace("C:/Users/me/proj", "D:/other", true), /outside/);
  assert.throws(() => resolveInWorkspace("C:/Users/me/proj", "..\\..\\secret", true), /outside/);
  assert.throws(() => resolveInWorkspace("C:/Users/me/proj", "c:/users/me/PROJ/x", false), /outside/);
  assert.equal(normalize("C:\\a\\b\\..\\c"), "C:/a/c");
  assert.ok(isInside("/", "/anything"));
  assert.equal(relative("/ws", "/ws/a/b.ts"), "a/b.ts");
});

test("executeTool refuses outside paths", async () => {
  const host = memoryHost({ "a.txt": "x" });
  await assert.rejects(executeTool(host, "read_file", { path: "../etc/passwd" }), /outside the workspace/);
  await assert.rejects(executeTool(host, "write_file", { path: "/tmp/evil", content: "x" }), /outside the workspace/);
  assert.equal(host.store.size, 1);
});

test("approval modes and plan-mode tools", () => {
  assert.equal(needsApproval("edit_file", "ask"), true);
  assert.equal(needsApproval("run_command", "ask"), true);
  assert.equal(needsApproval("read_file", "ask"), false);
  assert.equal(needsApproval("edit_file", "auto-edit"), false);
  assert.equal(needsApproval("run_command", "auto-edit"), true);
  assert.equal(needsApproval("mcp__gh__issue", "auto-edit"), true);
  assert.equal(needsApproval("mcp__gh__issue", "turbo"), false);
  assert.equal(needsApproval("run_command", "turbo"), false);
  assert.ok(isReadOnly("search") && !isReadOnly("edit_file") && !isReadOnly("run_command"));
  assert.ok(toolAllowed(null, "x") && toolAllowed(["mcp__gh__*"], "mcp__gh__a") && !toolAllowed(["read_file"], "edit_file"));
  assert.ok(toolAllowed(["read_file"], "update_plan"));
});

test("applyTo globs", () => {
  assert.ok(globMatch("**/*.ts", "src/a/b.ts"));
  assert.ok(globMatch("**/*.ts", "b.ts"));
  assert.ok(globMatch("*.{ts,tsx}", "src/x.tsx"));
  assert.ok(globMatch("src/**", "src/x/y.rs"));
  assert.ok(!globMatch("src/**/*.rs", "lib/x.rs"));
  assert.ok(globMatch("docs/*.md, **/*.py", "a/b.py"));
  assert.ok(!globMatch("docs/*.md", "docs/sub/a.md"));
  assert.ok(globMatch("src/*.ts", "./src/a.ts"));
  assert.ok(globMatch("file?.js", "file1.js") && !globMatch("file?.js", "file10.js"));
  assert.ok(!globMatch("*.TS", "a.ts") && globMatch("*.TS", "a.ts", true));
});

test("frontmatter", () => {
  let { data, body } = parseFrontmatter("---\nname: rev\ntools: [read_file, search]\nmodel: x\n---\nBody\n");
  assert.equal(fmStr(data, "name"), "rev");
  assert.deepEqual(fmList(data, "tools"), ["read_file", "search"]);
  assert.equal(body, "Body\n");
  ({ data } = parseFrontmatter("---\ntools:\n  - a\n  - 'b'\n---\n"));
  assert.deepEqual(fmList(data, "tools"), ["a", "b"]);
  ({ data, body } = parseFrontmatter('\uFEFF---\r\napplyTo: "src/**/*.ts"\r\n---\r\nRules'));
  assert.equal(fmStr(data, "applyTo"), "src/**/*.ts");
  assert.equal(body, "Rules");
  ({ data, body } = parseFrontmatter("no frontmatter\n---\n"));
  assert.deepEqual(data, {});
  assert.equal(body, "no frontmatter\n---\n");
  ({ data, body } = parseFrontmatter("---\nunterminated: yes\n"));
  assert.deepEqual(data, {});
});

test("hooks parsing and matching", () => {
  const a = parseHooks('{"hooks":[{"event":"preToolUse","matcher":"run_.*","command":"x"},{"event":"stop","command":"lint"}]}');
  assert.equal(a.length, 2);
  const b = parseHooks('{"hooks":{"postToolUse":[{"matcher":"edit_file|write_file","command":"fmt","timeout":5}]}}');
  assert.deepEqual(b, [{ event: "postToolUse", matcher: "edit_file|write_file", command: "fmt", timeout: 5 }]);
  assert.equal(parseHooks('[{"event":"stop","command":" "}]').length, 0);
  assert.equal(parseHooks("not json").length, 0);
  const c = { instructions: [], skills: [], agents: [], hooks: [...a, ...b] };
  assert.equal(hooksFor(c, "preToolUse", "run_command").length, 1);
  assert.equal(hooksFor(c, "pretooluse", "read_file").length, 0);
  assert.equal(hooksFor(c, "postToolUse", "write_file").length, 1);
  assert.equal(hooksFor(c, "postToolUse", "write_file_x").length, 0);
});

test("customizations: instruction files, applyTo, skills, agents", async () => {
  const host = memoryHost({
    "AGENTS.md": "Always run tests.",
    ".github/copilot-instructions.md": "Be nice.",
    ".cepheus/instructions/ts.md": "---\napplyTo: \"**/*.ts\"\n---\nUse strict TS.",
    ".cepheus/skills/release/SKILL.md": "---\nname: release\ndescription: Cut a release\n---\nSteps...",
    ".cepheus/skills/release/notes.md": "x",
    ".cepheus/agents/reviewer.md": "---\ntools: [read_file]\nmodel: m1\n---\nReview.",
    ".cepheus/hooks.json": '[{"event":"stop","command":"echo done"}]',
  });
  host.userSkillsDir = "/home/.cepheus/skills";
  host.store.set("/home/.cepheus/skills/release/SKILL.md", "---\nname: release\n---\nshadowed");
  host.store.set("/home/.cepheus/skills/docs/SKILL.md", "# Docs\nWrite docs well.");
  const c = await loadCustomizations(host);
  assert.deepEqual(c.instructions.map((i) => i.path), ["AGENTS.md", ".github/copilot-instructions.md", ".cepheus/instructions/ts.md"]);
  assert.deepEqual(applicableInstructions(c, []).map((i) => i.path), ["AGENTS.md", ".github/copilot-instructions.md"]);
  assert.equal(applicableInstructions(c, ["src/x.ts"]).length, 3);
  assert.deepEqual(c.skills.map((s) => [s.name, s.source, s.description]), [
    ["release", "workspace", "Cut a release"],
    ["docs", "user", "Write docs well."],
  ]);
  assert.deepEqual(c.agents[0], { name: "reviewer", description: "", tools: ["read_file"], model: "m1", path: ".cepheus/agents/reviewer.md", body: "Review." });
  assert.equal(c.hooks.length, 1);
});

test("diff stats and hunks", () => {
  assert.deepEqual(diffStats("a\nb\nc\n", "a\nB\nc\nd\n"), { added: 2, removed: 1 });
  assert.deepEqual(diffStats(null, "x\ny"), { added: 2, removed: 0 });
  const h = hunks("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "1\n2\nX\n4\n5\n6\n7\n8\nY\n10\n", 1);
  assert.equal(h.length, 2);
  assert.equal(h[0].oldStart, 2);
});
