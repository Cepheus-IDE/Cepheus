/** git_* commands over the git CLI, mirroring src-tauri/src/git.rs (names, arguments, result shapes). */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

type Args = Record<string, any>;

function git(root: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("git", args, { cwd: root, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    } catch (e) {
      return reject(new Error(`Failed to run git (is it installed?): ${e instanceof Error ? e.message : e}`));
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => reject(new Error(`Failed to run git (is it installed?): ${e.message}`)));
    child.on("close", (code) => {
      const so = Buffer.concat(out).toString("utf8");
      if (code === 0) return resolve(so);
      const se = Buffer.concat(err).toString("utf8").trim();
      reject(new Error(se || so.trim() || `git exited with code ${code}`));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function gitAuth(root: string, args: string[], token?: string | null): Promise<string> {
  const t = (token || "").trim();
  if (!t) return git(root, args);
  const b64 = Buffer.from(`x-access-token:${t}`).toString("base64");
  return git(root, ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${b64}`, ...args]).catch((e) => {
    throw new Error(String(e.message).split(b64).join("***"));
  });
}

function rel(root: string, p: string): string {
  const r = path.relative(root, path.resolve(root, p));
  if (r.startsWith("..") || path.isAbsolute(r)) return p;
  return r.replace(/\\/g, "/");
}

const LOG_FMT = "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D";

function parseLog(raw: string, withFiles: boolean) {
  return raw
    .split("\x1e")
    .filter((r) => r.trim())
    .map((rec) => {
      const nl = rec.indexOf("\n");
      const head = nl < 0 ? rec : rec.slice(0, nl);
      const f = head.split("\x1f");
      if (f.length < 7) return null;
      const file = withFiles && nl >= 0 ? rec.slice(nl + 1).split("\n").map((l) => l.trim()).find((l) => l) ?? null : null;
      return {
        hash: f[0],
        parents: f[1].split(/\s+/).filter(Boolean),
        author: f[2],
        email: f[3],
        time: Number(f[4].trim()) || 0,
        subject: f[5],
        refs: f[6].trim().split(", ").map((s) => s.trim()).filter(Boolean),
        file,
      };
    })
    .filter(Boolean);
}

const trackNum = (track: string, word: string) => {
  for (const p of track.split(/[[\],]/).map((s) => s.trim())) if (p.startsWith(word)) return Number(p.slice(word.length).trim()) || 0;
  return 0;
};

const RUN_ALLOWED = ["branch", "tag", "merge", "rebase", "reset", "fetch", "pull", "push", "commit", "checkout", "switch", "revert",
  "cherry-pick", "remote", "rev-parse", "rev-list", "log", "show", "diff", "status", "restore"];

/** `confine(p)` returns an allowed absolute path or throws. */
export function gitCommands(confine: (p: unknown, what?: string) => string): Record<string, (a: Args) => Promise<any>> {
  const R = (a: Args) => confine(a.root, "root");
  return {
    async git_status(a) {
      const root = R(a);
      let raw: string;
      try {
        raw = await git(root, ["status", "--porcelain=v1", "-b", "-z", "-uall"]);
      } catch {
        return { isRepo: false, branch: "", aheadBehind: "", files: [] };
      }
      let branch = "";
      let aheadBehind = "";
      const files = [];
      const parts = raw.split("\0").filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const entry = parts[i];
        if (entry.startsWith("## ")) {
          const b = entry.slice(3);
          const k = b.indexOf(" [");
          const name = k >= 0 ? b.slice(0, k) : b;
          const rest = k >= 0 ? b.slice(k).trim() : "";
          branch = name.split("...")[0].replace("No commits yet on ", "");
          aheadBehind = rest.replace(/^\[|\]$/g, "");
          continue;
        }
        if (entry.length < 4) continue;
        const x = entry[0];
        const y = entry[1];
        if (x === "R" || x === "C") i++; // original path
        files.push({ path: path.join(root, entry.slice(3)), index: x, worktree: y });
      }
      return { isRepo: true, branch, aheadBehind, files };
    },
    async git_stage(a) {
      const root = R(a);
      await git(root, ["add", "--", ...(a.paths ?? []).map((p: string) => rel(root, p))]);
      return null;
    },
    async git_unstage(a) {
      const root = R(a);
      await git(root, ["reset", "-q", "--", ...(a.paths ?? []).map((p: string) => rel(root, p))]);
      return null;
    },
    git_commit: (a) => git(R(a), ["commit", "-m", String(a.message ?? "")]),
    async git_discard(a) {
      const root = R(a);
      await git(root, ["checkout", "--", rel(root, a.path)]);
      return null;
    },
    async git_show_head(a) {
      const root = R(a);
      return git(root, ["show", `HEAD:${rel(root, a.path)}`]).catch(() => "");
    },
    async git_init(a) {
      await git(R(a), ["init"]);
      return null;
    },
    async git_diff_staged(a) {
      const root = R(a);
      const d = await git(root, ["diff", "--cached"]);
      return d.trim() ? d : git(root, ["diff"]);
    },
    async git_branches(a) {
      return (await git(R(a), ["branch", "--format=%(refname:short)"])).split("\n").map((s) => s.trim()).filter(Boolean);
    },
    async git_checkout(a) {
      await git(R(a), a.create ? ["checkout", "-b", a.branch] : ["checkout", a.branch]);
      return null;
    },
    git_sync(a) {
      const root = R(a);
      const args = a.action === "pull" ? ["pull", "--ff-only"] : a.action === "push" ? ["push", "-u", "origin", "HEAD"] : ["fetch", "--all"];
      return gitAuth(root, args, a.token);
    },
    async git_clone(a) {
      const parent = confine(a.parent, "parent");
      const name = String(a.name ?? "");
      if (!name || /[\\/]/.test(name) || name === "..") throw new Error("Invalid folder name");
      const dest = path.join(parent, name);
      if (fs.existsSync(dest)) throw new Error(`'${dest}' already exists`);
      await gitAuth(parent, ["clone", String(a.url), name], a.token);
      return dest;
    },
    git_remote: (a) => git(R(a), ["remote", "get-url", "origin"]).then((s) => s.trim()).catch(() => ""),
    async git_publish(a) {
      const root = R(a);
      if (!(await git(root, ["rev-parse", "--git-dir"]).then(() => true).catch(() => false))) await git(root, ["init"]);
      if (!(await git(root, ["rev-parse", "HEAD"]).then(() => true).catch(() => false))) {
        await git(root, ["add", "-A"]);
        await git(root, ["commit", "-m", "Initial commit"]);
      }
      if (!(await git(root, ["remote", "get-url", "origin"]).then(() => true).catch(() => false))) await git(root, ["remote", "add", "origin", a.url]);
      return gitAuth(root, ["push", "-u", "origin", "HEAD"], a.token);
    },
    git_current_branch: (a) => git(R(a), ["rev-parse", "--abbrev-ref", "HEAD"]).then((s) => s.trim()).catch(() => ""),
    async git_blame(a) {
      const root = R(a);
      const raw = await git(root, ["blame", "--porcelain", "--", rel(root, a.path)]);
      const info = new Map<string, { hash: string; author: string; time: number; summary: string }>();
      const out = [];
      let cur: string | null = null;
      for (const line of raw.split("\n")) {
        if (line.startsWith("\t")) {
          if (cur) out.push({ ...(info.get(cur) ?? { hash: cur, author: "", time: 0, summary: "" }) });
          cur = null;
          continue;
        }
        const sp = line.indexOf(" ");
        const k = sp < 0 ? line : line.slice(0, sp);
        const v = sp < 0 ? "" : line.slice(sp + 1);
        if (/^[0-9a-f]{40}$/.test(k)) {
          cur = k;
          if (!info.has(k)) info.set(k, { hash: k, author: "", time: 0, summary: "" });
          continue;
        }
        const e = cur ? info.get(cur) : undefined;
        if (!e) continue;
        if (k === "author") e.author = v;
        else if (k === "author-time") e.time = Number(v) || 0;
        else if (k === "summary") e.summary = v;
      }
      return out;
    },
    async git_stash_list(a) {
      const out = await git(R(a), ["stash", "list", "--format=%gs"]);
      return out.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === "")).map((message, index) => ({ index, message }));
    },
    git_stash(a) {
      const root = R(a);
      const ref = a.index != null ? `stash@{${a.index}}` : null;
      if (a.action === "push") {
        const args = ["stash", "push", "--include-untracked"];
        if (a.message && String(a.message).trim()) args.push("-m", a.message);
        return git(root, args);
      }
      if (["pop", "apply", "drop"].includes(a.action)) return git(root, ["stash", a.action, ...(ref ? [ref] : [])]);
      throw new Error(`Unknown stash action '${a.action}'`);
    },
    async git_identity(a) {
      const root = R(a);
      const get = (k: string) => git(root, ["config", "--get", k]).then((s) => s.trim()).catch(() => "");
      return { name: await get("user.name"), email: await get("user.email") };
    },
    async git_set_identity(a) {
      const root = R(a);
      const scope = a.global ? "--global" : "--local";
      await git(root, ["config", scope, "user.name", String(a.name ?? "").trim()]);
      await git(root, ["config", scope, "user.email", String(a.email ?? "").trim()]);
      return null;
    },
    git_show_rev(a) {
      const root = R(a);
      return git(root, ["show", `${a.rev}:${rel(root, a.path)}`]);
    },
    async git_log(a) {
      const root = R(a);
      const args = ["log", LOG_FMT, `--max-count=${a.maxCount ?? 300}`, `--skip=${a.skip ?? 0}`];
      const rp = a.path ? rel(root, a.path) : null;
      if (rp) args.push("--follow", "--name-only", "--", rp);
      else {
        args.push("--topo-order");
        if (a.all) args.push("--all");
      }
      try {
        return parseLog(await git(root, args), !!rp);
      } catch (e: any) {
        if (/does not have any commits|bad default revision/.test(e.message)) return [];
        throw e;
      }
    },
    async git_commit_details(a) {
      const root = R(a);
      const meta = await git(root, ["show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%B", a.hash]);
      const f = meta.split("\x1f");
      if (f.length < 7) throw new Error("Unexpected git output");
      const body = f.slice(6).join("\x1f");
      const parents = f[1].split(/\s+/).filter(Boolean);
      const raw = parents[0]
        ? await git(root, ["diff", "--name-status", "-M", "-z", parents[0], f[0]])
        : await git(root, ["diff-tree", "--root", "-r", "--no-commit-id", "--name-status", "-M", "-z", f[0]]);
      const files = [];
      const it = raw.split("\0").filter(Boolean);
      for (let i = 0; i < it.length; i++) {
        const status = it[i][0] ?? "M";
        if (status === "R" || status === "C") {
          files.push({ path: it[i + 2] ?? "", oldPath: it[i + 1] ?? "", status });
          i += 2;
        } else if (i + 1 < it.length) {
          files.push({ path: it[i + 1], oldPath: null, status });
          i += 1;
        }
      }
      return { hash: f[0], parents, author: f[2], email: f[3], time: Number(f[4].trim()) || 0, committer: f[5], body: body.trimEnd(), files };
    },
    async git_refs(a) {
      const root = R(a);
      const raw = await git(root, ["for-each-ref", "--sort=-committerdate",
        "--format=%(refname)%1f%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:track)%1f%(objectname:short)%1f%(committerdate:unix)%1f%(contents:subject)",
        "refs/heads", "refs/remotes"]);
      const branches = [];
      for (const line of raw.split("\n")) {
        const f = line.split("\x1f");
        if (f.length < 8 || f[0].endsWith("/HEAD")) continue;
        branches.push({
          name: f[1], remote: f[0].startsWith("refs/remotes/"), current: f[2] === "*", upstream: f[3],
          ahead: trackNum(f[4], "ahead "), behind: trackNum(f[4], "behind "), gone: f[4].includes("gone"),
          hash: f[5], time: Number(f[6].trim()) || 0, subject: f[7],
        });
      }
      const traw = await git(root, ["for-each-ref", "--sort=-creatordate", "--format=%(refname:short)%1f%(objectname:short)%1f%(contents:subject)", "refs/tags"]);
      const tags = traw.split("\n").map((l) => l.split("\x1f")).filter((f) => f.length >= 3).map((f) => ({ name: f[0], hash: f[1], subject: f[2] }));
      return { branches, tags };
    },
    git_run(a) {
      const root = R(a);
      const args: string[] = (a.args ?? []).map(String);
      const sub = args[0] ?? "";
      if (!RUN_ALLOWED.includes(sub)) throw new Error(`git ${sub} is not allowed here`);
      const full = ["-c", "core.editor=true", ...args];
      return ["fetch", "pull", "push"].includes(sub) ? gitAuth(root, full, a.token) : git(root, full);
    },
    async git_apply(a) {
      const args = ["apply", "--unidiff-zero", "--whitespace=nowarn"];
      if (a.cached) args.push("--cached");
      if (a.reverse) args.push("--reverse");
      args.push("-");
      await git(R(a), args, String(a.patch ?? ""));
      return null;
    },
  };
}
