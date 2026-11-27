//! Apple Builds: build iOS / macOS apps on GitHub-hosted macOS runners (no Mac needed), plus the
//! Expo Go and Swift-on-Windows/Linux fast paths. Detection and YAML generation are pure
//! (appleDetect.ts, appleWorkflow.ts); this file wires them to the workspace, git and GitHub.

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api, errMsg } from "./api";
import { gh, ghText, parseRemote } from "./github";
import { runCommand, shellQuote } from "./procBus";
import { runInTerminal } from "./terminalBus";
import { openDiff, refreshGit } from "./workspace";
import { get, set, toast } from "../store";
import { AppleProject, detectAppleProjects, FsLike } from "./appleDetect";
import { defaultOptions, generateWorkflow, Templates, WORKFLOW_FILE, WORKFLOW_PATH, WorkflowOptions } from "./appleWorkflow";
import workflowTpl from "../apple/workflow.yml?raw";
import signingTpl from "../apple/signing.yml?raw";
import profileTpl from "../apple/profile.yml?raw";
import testflightTpl from "../apple/testflight.yml?raw";
import notarizeTpl from "../apple/notarize.yml?raw";

export const TEMPLATES: Templates = { workflow: workflowTpl, signing: signingTpl, profile: profileTpl, testflight: testflightTpl, notarize: notarizeTpl };
export const BILLING_URL = "https://docs.github.com/billing";

const isWin = () => navigator.userAgent.includes("Windows");
const isMac = () => navigator.userAgent.includes("Mac");

/** Absolute path of a workspace-relative "/" path. */
export function wsPath(ws: string, rel: string): string {
  const sep = ws.startsWith("ssh://") || !ws.includes("\\") ? "/" : "\\";
  return rel ? ws.replace(/[\\/]+$/, "") + sep + rel.replace(/\//g, sep) : ws;
}

function workspaceFs(ws: string): FsLike {
  return {
    list: (dir) => api.readDir(wsPath(ws, dir)).then((es) => es.map((e) => ({ name: e.name, isDir: e.isDir }))).catch(() => []),
    read: (p) => api.readFile(wsPath(ws, p)).catch(() => null),
  };
}

// ---------- UI state (kept across sidebar switches) ----------

export interface GhRun {
  id: number; run_number: number; name: string; display_title: string; status: string; conclusion: string | null; html_url: string;
  event: string; head_branch: string; created_at: string; updated_at: string; run_started_at?: string; run_attempt?: number;
}
export interface GhStep { name: string; status: string; conclusion: string | null; number: number; started_at?: string | null; completed_at?: string | null }
export interface GhJob { id: number; name: string; status: string; conclusion: string | null; html_url: string; started_at: string | null; completed_at: string | null; steps?: GhStep[] }
export interface GhArtifact { id: number; name: string; size_in_bytes: number; expired: boolean; archive_download_url: string }
export interface RepoRef { owner: string; repo: string }
export interface RepoInfo { private: boolean; default_branch: string; html_url: string }

/** local: file on disk; committed: no uncommitted git changes to it; remote: same content on GitHub for the current branch. */
export interface WorkflowStatus { local: string | null; dirty: boolean; remote: "same" | "different" | "missing" | "unknown"; branch: string }

interface AppleUi {
  scanning: boolean;
  projects: AppleProject[];
  selected: number;
  opts: WorkflowOptions | null;
  preview: { text: string; existing: string | null } | null;
  confirmOverwrite: boolean;
  repo: RepoRef | null;
  repoInfo: RepoInfo | null;
  wf: WorkflowStatus | null;
  runs: GhRun[];
  runId: number | null;
  jobs: GhJob[];
  artifacts: GhArtifact[];
  log: { jobId: number; step: number | null; text: string; loading: boolean; error?: string } | null;
  expoUrl: string | null;
  expoWatching: boolean;
  swiftAvailable: boolean | null;
}

export const useAppleUi = create<AppleUi>(() => ({
  scanning: false, projects: [], selected: 0, opts: null, preview: null, confirmOverwrite: false,
  repo: null, repoInfo: null, wf: null, runs: [], runId: null, jobs: [], artifacts: [], log: null,
  expoUrl: null, expoWatching: false, swiftAvailable: null,
}));
const setUi = useAppleUi.setState;

export const selectedProject = (s = useAppleUi.getState()) => s.projects[s.selected] ?? null;

// ---------- detection ----------

export async function scanWorkspace() {
  const ws = get().workspace;
  if (!ws) return setUi({ projects: [], opts: null });
  setUi({ scanning: true });
  try {
    const projects = await detectAppleProjects(workspaceFs(ws));
    const cur = selectedProject();
    const idx = Math.max(0, projects.findIndex((p) => cur && p.kind === cur.kind && p.dir === cur.dir));
    setUi({ projects, selected: idx, opts: projects[idx] ? { ...defaultOptions(projects[idx]), ...keepOpts(projects[idx]) } : null, preview: null });
    if (projects.some((p) => p.kind === "spm")) api.which(["swift"]).then((f) => setUi({ swiftAvailable: f.includes("swift") })).catch(() => setUi({ swiftAvailable: false }));
  } catch (e) {
    toast(errMsg(e), "error");
  } finally {
    setUi({ scanning: false });
  }
}

/** Keeps the user's option edits when re-scanning the same project. */
function keepOpts(p: AppleProject): Partial<WorkflowOptions> {
  const s = useAppleUi.getState();
  const cur = selectedProject(s);
  return cur && s.opts && cur.kind === p.kind && cur.dir === p.dir ? s.opts : {};
}

export function selectProject(i: number) {
  const p = useAppleUi.getState().projects[i];
  if (p) setUi({ selected: i, opts: defaultOptions(p), preview: null, confirmOverwrite: false });
}

// ---------- workflow file ----------

export async function previewWorkflow(openAsDiff = true) {
  const ws = get().workspace;
  const { opts } = useAppleUi.getState();
  const p = selectedProject();
  if (!ws || !p || !opts) return;
  try {
    const text = generateWorkflow(p, opts, TEMPLATES);
    const path = wsPath(ws, WORKFLOW_PATH);
    const existing = (await api.exists(path).catch(() => false)) ? await api.readFile(path) : null;
    setUi({ preview: { text, existing }, confirmOverwrite: false });
    if (openAsDiff) openDiff(path, existing ?? "", text, existing == null ? "New file" : "Current file");
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

/** Writes the previewed workflow. Overwriting an existing, different file needs `confirmed`. */
export async function writeWorkflow(confirmed: boolean): Promise<boolean> {
  const ws = get().workspace;
  const { preview } = useAppleUi.getState();
  if (!ws || !preview) return false;
  if (preview.existing != null && preview.existing !== preview.text && !confirmed) {
    setUi({ confirmOverwrite: true });
    return false;
  }
  try {
    await api.createDir(wsPath(ws, ".github/workflows"));
    await api.writeFile(wsPath(ws, WORKFLOW_PATH), preview.text);
    setUi({ preview: null, confirmOverwrite: false });
    toast(`Wrote ${WORKFLOW_PATH}`);
    refreshGit();
    await refreshWorkflowStatus();
    return true;
  } catch (e) {
    toast(errMsg(e), "error");
    return false;
  }
}

/** Stages and commits only the workflow file (caller asks the user first). Never pushes. */
export async function commitWorkflow() {
  const ws = get().workspace;
  if (!ws) return;
  try {
    // `git commit` takes everything staged; refuse rather than sweep the user's other staged work in.
    const st = await api.gitStatus(ws);
    const other = st.files.filter((f) => f.index.trim() && f.index !== "?" && !f.path.replace(/\\/g, "/").endsWith(WORKFLOW_PATH));
    if (other.length) throw new Error(`Other changes are staged (${other.length} file${other.length > 1 ? "s" : ""}). Commit or unstage them first, then commit the workflow.`);
    await api.gitStage(ws, [WORKFLOW_PATH]);
    await api.gitCommit(ws, "Add Cepheus Apple build workflow (GitHub Actions macOS runners)");
    toast("Committed the workflow. Press Sync to push it to GitHub.");
  } catch (e) {
    toast(errMsg(e), "error");
  } finally {
    refreshGit();
    await refreshWorkflowStatus();
  }
}

// ---------- GitHub ----------

const base = (r: RepoRef) => `/repos/${r.owner}/${r.repo}`;
const isNotFound = (e: unknown) => /Not Found|404/.test(errMsg(e));

export async function connectRepo() {
  const ws = get().workspace;
  if (!ws) return;
  const remote = await api.gitRemote(ws).catch(() => "");
  const repo = parseRemote(remote);
  setUi({ repo, repoInfo: null });
  if (!repo || !get().settings.githubToken) return;
  try {
    setUi({ repoInfo: await gh<RepoInfo>(base(repo)) });
  } catch (e) {
    toast(errMsg(e), "error");
  }
  await Promise.all([refreshWorkflowStatus(), refreshRuns()]);
}

export async function refreshWorkflowStatus() {
  const ws = get().workspace;
  if (!ws) return;
  const { repo } = useAppleUi.getState();
  const path = wsPath(ws, WORKFLOW_PATH);
  const local = (await api.exists(path).catch(() => false)) ? await api.readFile(path).catch(() => null) : null;
  const status = await api.gitStatus(ws).catch(() => null);
  const dirty = !!status?.files.some((f) => f.path.replace(/\\/g, "/").endsWith(WORKFLOW_PATH));
  const branch = status?.branch || (await api.gitCurrentBranch(ws).catch(() => ""));
  let remote: WorkflowStatus["remote"] = "unknown";
  if (repo && get().settings.githubToken && branch) {
    try {
      const text = await ghText(`${base(repo)}/contents/${WORKFLOW_PATH}?ref=${encodeURIComponent(branch)}`);
      remote = local != null && norm(text) === norm(local) ? "same" : "different";
    } catch (e) {
      remote = /404/.test(errMsg(e)) ? "missing" : "unknown";
    }
  }
  setUi({ wf: { local, dirty, remote, branch } });
}
const norm = (s: string) => s.replace(/\r\n/g, "\n").trimEnd();

export async function refreshRuns() {
  const { repo } = useAppleUi.getState();
  if (!repo || !get().settings.githubToken) return;
  try {
    const r = await gh<{ workflow_runs: GhRun[] }>(`${base(repo)}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=15`);
    setUi({ runs: r.workflow_runs });
  } catch (e) {
    if (isNotFound(e)) setUi({ runs: [] });
    else toast(errMsg(e), "error");
  }
}

export async function selectRun(runId: number | null) {
  setUi({ runId, jobs: [], artifacts: [], log: null });
  if (runId) await refreshRunDetails();
}

export async function refreshRunDetails() {
  const { repo, runId } = useAppleUi.getState();
  if (!repo || !runId) return;
  try {
    const [run, jobs, arts] = await Promise.all([
      gh<GhRun>(`${base(repo)}/actions/runs/${runId}`),
      gh<{ jobs: GhJob[] }>(`${base(repo)}/actions/runs/${runId}/jobs?per_page=50`),
      gh<{ artifacts: GhArtifact[] }>(`${base(repo)}/actions/runs/${runId}/artifacts?per_page=50`),
    ]);
    if (useAppleUi.getState().runId !== runId) return;
    setUi((s) => ({ jobs: jobs.jobs, artifacts: arts.artifacts, runs: s.runs.map((r) => (r.id === run.id ? run : r)) }));
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

export interface DispatchInputs { scheme: string; configuration: string; target: string; tests: boolean; testflight: boolean }

/** workflow_dispatch on the current branch, then waits briefly for the new run to show up. */
export async function startBuild(inputs: DispatchInputs, hasTests: boolean, hasTestflight: boolean) {
  const { repo, wf } = useAppleUi.getState();
  if (!repo || !wf?.branch) return;
  const payload: Record<string, string> = { scheme: inputs.scheme, configuration: inputs.configuration, target: inputs.target };
  if (hasTests) payload.tests = String(inputs.tests);
  if (hasTestflight) payload.testflight = String(inputs.testflight && inputs.target === "device");
  const since = Date.now() - 10_000;
  try {
    await gh(`${base(repo)}/actions/workflows/${WORKFLOW_FILE}/dispatches`, { method: "POST", body: JSON.stringify({ ref: wf.branch, inputs: payload }) });
    toast("Build requested — waiting for GitHub to start it…");
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      await refreshRuns();
      const run = useAppleUi.getState().runs.find((r) => r.event === "workflow_dispatch" && Date.parse(r.created_at) >= since);
      if (run) { await selectRun(run.id); return; }
    }
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

export async function runAction(runId: number, action: "cancel" | "rerun" | "rerun-failed-jobs") {
  const { repo } = useAppleUi.getState();
  if (!repo) return;
  try {
    await gh(`${base(repo)}/actions/runs/${runId}/${action}`, { method: "POST" });
    toast(action === "cancel" ? "Cancelling run…" : "Re-run requested");
    setTimeout(() => { refreshRuns(); refreshRunDetails(); }, 2500);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

// ---------- logs and artifacts (downloaded with curl: GitHub answers with a redirect to signed storage) ----------

function curl(url: string, outFile?: string): string {
  const auth = isWin() ? `"Authorization: Bearer %CEPHEUS_GH_TOKEN%"` : `"Authorization: Bearer $CEPHEUS_GH_TOKEN"`;
  // -L follows the redirect; curl drops the Authorization header when the host changes.
  return `curl -sSfL -H ${auth} -H "X-GitHub-Api-Version: 2022-11-28"${outFile ? ` -o ${shellQuote(outFile)}` : ""} ${shellQuote(url)}`;
}
const tokenEnv = () => ({ CEPHEUS_GH_TOKEN: get().settings.githubToken });

export async function loadJobLog(job: GhJob, stepNumber: number | null) {
  const { repo } = useAppleUi.getState();
  if (!repo) return;
  const cached = useAppleUi.getState().log;
  if (cached && cached.jobId === job.id && !cached.error && cached.text && job.status === "completed") {
    return setUi({ log: { ...cached, step: stepNumber } });
  }
  setUi({ log: { jobId: job.id, step: stepNumber, text: "", loading: true } });
  const res = await runCommand(curl(`https://api.github.com${base(repo)}/actions/jobs/${job.id}/logs`), null, { env: tokenEnv() }).done;
  if (useAppleUi.getState().log?.jobId !== job.id) return;
  if (res.code === 0 && res.stdout) setUi({ log: { jobId: job.id, step: stepNumber, text: res.stdout, loading: false } });
  else setUi({
    log: {
      jobId: job.id, step: stepNumber, text: "", loading: false,
      error: job.status !== "completed"
        ? "GitHub makes a job's log downloadable when the job finishes. Open the run on GitHub to watch it live."
        : (res.stderr.trim() || "Could not download the log (is curl installed?)"),
    },
  });
}

/** Lines of a job log that belong to one step, matched by the step's start/end timestamps (second precision). */
export function sliceStepLog(full: string, step: GhStep | undefined): string {
  if (!step?.started_at) return full;
  const start = Math.floor(Date.parse(step.started_at) / 1000) * 1000;
  const end = step.completed_at ? Math.floor(Date.parse(step.completed_at) / 1000) * 1000 + 999 : Infinity;
  const out: string[] = [];
  let keep = false;
  for (const line of full.split(/\r?\n/)) {
    const m = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?(.*)$/);
    if (m) {
      const t = Date.parse(m[1]);
      keep = t >= start && t <= end;
      if (keep) out.push(m[2]);
    } else if (keep) out.push(line);
  }
  return out.length ? out.join("\n") : "(No log lines in this step's time range — showing nothing. Select the job header for the full log.)";
}

export async function downloadArtifact(a: GhArtifact, runId: number): Promise<void> {
  const ws = get().workspace;
  if (!ws) return;
  if (ws.startsWith("ssh://")) return toast("Artifact download needs a local folder.", "error");
  const dirRel = `artifacts/${runId}`;
  const zip = wsPath(ws, `${dirRel}/${a.name}.zip`);
  const dest = wsPath(ws, `${dirRel}/${a.name}`);
  try {
    await api.createDir(wsPath(ws, dirRel));
    // Keep downloaded binaries out of git without touching the project's own .gitignore.
    const gi = wsPath(ws, "artifacts/.gitignore");
    if (!(await api.exists(gi).catch(() => false))) await api.writeFile(gi, "# Downloaded by Cepheus Apple Builds\n*\n");
    toast(`Downloading ${a.name}…`);
    const dl = await runCommand(curl(a.archive_download_url, zip), null, { env: tokenEnv() }).done;
    if (dl.code !== 0) throw new Error(dl.stderr.trim() || "Download failed (is curl installed?)");
    await api.createDir(dest);
    const unzip = isWin() || isMac() ? `tar -xf ${shellQuote(zip)} -C ${shellQuote(dest)}` : `unzip -o -q ${shellQuote(zip)} -d ${shellQuote(dest)}`;
    const x = await runCommand(unzip, null).done;
    if (x.code === 0) { await api.remove(zip).catch(() => {}); toast(`Saved to ${dirRel}/${a.name}/`); }
    else toast(`Saved ${dirRel}/${a.name}.zip (could not extract it here)`);
    set((s) => ({ treeVersion: s.treeVersion + 1 }));
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

// ---------- durations and usage ----------

const ms = (a?: string | null, b?: string | null) => (a ? (b ? Date.parse(b) : Date.now()) - Date.parse(a) : 0);

export function fmtDuration(msec: number): string {
  const s = Math.max(0, Math.round(msec / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function runDuration(r: GhRun): number {
  return ms(r.run_started_at ?? r.created_at, r.status === "completed" ? r.updated_at : null);
}

/** GitHub rounds each job up to the whole minute; this is an estimate, not a bill. */
export function jobMinutes(jobs: GhJob[]): number {
  return jobs.reduce((n, j) => n + (j.started_at ? Math.ceil(ms(j.started_at, j.completed_at) / 60000) : 0), 0);
}

// ---------- Expo Go / EAS / local Swift ----------

const cdPrefix = (dir: string) => (!dir ? "" : isWin() ? `cd /d ${shellQuote(dir.replace(/\//g, "\\"))} && ` : `cd ${shellQuote(dir)} && `);
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "");
let expoUnlisten: (() => void) | null = null;

/** Starts `expo start --tunnel` in a terminal and picks the exp:// URL out of terminal output. */
export async function startExpoGo(p: AppleProject) {
  setUi({ expoUrl: null, expoWatching: true });
  expoUnlisten?.();
  let buf = "";
  expoUnlisten = await listen<{ id: number; data: string }>("term-data", (e) => {
    buf = (buf + stripAnsi(e.payload.data)).slice(-4000);
    const m = buf.match(/exps?:\/\/[^\s"'<>│|]+/);
    if (m) {
      setUi({ expoUrl: m[0].replace(/[.,)]+$/, ""), expoWatching: false });
      expoUnlisten?.();
      expoUnlisten = null;
    }
  });
  runInTerminal({ title: "Expo Go", command: `${cdPrefix(p.dir)}npx expo start --tunnel` });
}

export function stopExpoWatch() {
  expoUnlisten?.();
  expoUnlisten = null;
  setUi({ expoWatching: false });
}

export const setExpoUrl = (url: string | null) => setUi({ expoUrl: url });

export function startEas(p: AppleProject) {
  runInTerminal({ title: "EAS Build", command: `${cdPrefix(p.dir)}npx eas-cli build --platform ios` });
}

export function swiftLocal(p: AppleProject) {
  runInTerminal({ title: "Swift package", command: `${cdPrefix(p.dir)}swift build && swift test` });
}

// ---------- entry points for commands ----------

export function openAppleBuilds() {
  set({ sidebar: "apple", view: "editor" });
}

export async function commandGenerateWorkflow() {
  openAppleBuilds();
  if (!useAppleUi.getState().projects.length) await scanWorkspace();
  if (!selectedProject()) return toast("No iOS or macOS project found in this folder.", "error");
  await previewWorkflow(true);
}

export async function commandExpoGo() {
  openAppleBuilds();
  if (!useAppleUi.getState().projects.length) await scanWorkspace();
  const p = useAppleUi.getState().projects.find((x) => x.kind === "expo");
  if (!p) return toast("No Expo project found in this folder.", "error");
  await startExpoGo(p);
}
