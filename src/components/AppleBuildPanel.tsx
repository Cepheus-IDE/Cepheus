import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { set, toast, useStore } from "../store";
import { errMsg } from "../lib/api";
import { syncNow } from "../lib/gitApi";
import { buildOptions, testLabel } from "../lib/appleDetect";
import { BuildTarget, enabledTargets, recipe, requiredSecrets, WORKFLOW_PATH, WorkflowOptions } from "../lib/appleWorkflow";
import {
  BILLING_URL, commitWorkflow, connectRepo, downloadArtifact, fmtDuration, GhJob, GhRun, jobMinutes, loadJobLog, previewWorkflow,
  refreshRunDetails, refreshRuns, refreshWorkflowStatus, runAction, runDuration, scanWorkspace, selectedProject, selectProject, selectRun,
  setExpoUrl, sliceStepLog, startBuild, startEas, startExpoGo, stopExpoWatch, swiftLocal, useAppleUi, writeWorkflow,
} from "../lib/appleBuild";
import { encodeQr, qrPath } from "../lib/qr";

const ui = useAppleUi.setState;

export default function AppleBuildPanel() {
  const ws = useStore((s) => s.workspace);
  const token = useStore((s) => s.settings.githubToken);
  const reduceMotion = useStore((s) => (s.settings as { reduceMotion?: boolean }).reduceMotion ?? false);
  const s = useAppleUi();
  const p = selectedProject(s);

  useEffect(() => { scanWorkspace().then(connectRepo); }, [ws, token]);

  return (
    <div className={`panel apple-panel${reduceMotion ? " reduce-motion" : ""}`}>
      <div className="panel-header">
        <span>Apple Builds</span>
        <div className="actions">
          <button title="Rescan the folder" onClick={() => scanWorkspace().then(connectRepo)}><i className="codicon codicon-refresh" /></button>
        </div>
      </div>
      <div className="tree">
        <p className="apple-note muted small">
          Build iOS and macOS apps without a Mac: the build runs on GitHub-hosted macOS machines (GitHub Actions).
          Simulator and unsigned macOS builds need no Apple account. Installing on a real iPhone, TestFlight and the App Store
          need an <b>Apple Developer Program</b> membership and code signing.
        </p>
        {!ws && <div className="empty-state"><p>Open a folder with an iOS or macOS project.</p></div>}
        {ws && <Projects />}
        {ws && p && <QuickPaths />}
        {ws && p && s.opts && <Generator />}
        {ws && p && s.opts && (s.opts.device || s.opts.notarize) && <SigningChecklist opts={s.opts} />}
        {ws && <Cloud />}
      </div>
    </div>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="apple-section">
      <div className="section-title"><span>{title}</span>{right}</div>
      <div className="apple-body">{children}</div>
    </div>
  );
}

// ---------- detection ----------

function Projects() {
  const { projects, selected, scanning } = useAppleUi();
  if (scanning && !projects.length) return <Section title="PROJECTS"><p className="muted small">Scanning…</p></Section>;
  if (!projects.length) {
    return (
      <Section title="PROJECTS">
        <p className="muted small">No Apple-platform project found. Cepheus looks for Xcode projects, Swift packages, Flutter, React Native, Expo, Tauri,
          Capacitor, Kotlin Multiplatform (iosApp/) and .NET MAUI (net*-ios) in this folder and two levels below.</p>
      </Section>
    );
  }
  return (
    <Section title={`PROJECTS · ${projects.length}`}>
      {projects.map((p, i) => (
        <label key={`${p.kind}:${p.dir}`} className={`apple-project${i === selected ? " active" : ""}`}>
          <input type="radio" checked={i === selected} onChange={() => selectProject(i)} />
          <div>
            <div><b>{p.label}</b> <span className="muted">{p.dir || "(root)"}</span></div>
            <div className="muted small">
              {[p.platforms.ios && "iOS", p.platforms.macos && "macOS"].filter(Boolean).join(" + ") || "—"}
              {p.scheme && <> · scheme <code>{p.scheme}</code></>} · {p.evidence.map((e) => <code key={e}>{e} </code>)}
            </div>
            {p.notes.map((n) => <div key={n} className="muted small">{n}</div>)}
            {i === selected && (
              <ul className="apple-options">
                {buildOptions(p).map((o) => (
                  <li key={o.id} title={o.detail}>
                    <i className={`codicon codicon-${o.needsAccount ? "lock" : "check"}`} /> {o.label}
                    <span className="muted small"> — {o.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </label>
      ))}
    </Section>
  );
}

// ---------- Expo Go / EAS / Swift ----------

function QuickPaths() {
  const s = useAppleUi();
  const p = selectedProject(s)!;
  const [manual, setManual] = useState("");
  if (p.kind !== "expo" && !(p.kind === "spm" && p.swiftPortable)) return null;
  return (
    <Section title="FAST PATHS">
      {p.kind === "expo" && (
        <>
          <div className="apple-row">
            <button className="btn small primary" onClick={() => startExpoGo(p).catch((e) => toast(errMsg(e), "error"))}>
              <i className="codicon codicon-device-mobile" /> Preview on iPhone with Expo Go
            </button>
            {s.expoWatching && <button className="btn small" onClick={stopExpoWatch}>Stop watching</button>}
          </div>
          <p className="muted small">Runs <code>npx expo start --tunnel</code> in a terminal. Install the free <b>Expo Go</b> app from the App Store, then scan the code with the iPhone Camera. Works for code that runs in Expo Go; custom native modules need a real build.</p>
          {s.expoWatching && !s.expoUrl && <p className="muted small">Waiting for Expo to print its exp:// address… (the first tunnel start may ask to install <code>@expo/ngrok</code> in the terminal)</p>}
          {s.expoUrl && <Qr text={s.expoUrl} />}
          <div className="apple-row">
            <input placeholder="or paste an exp:// URL" value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => e.key === "Enter" && manual.trim() && setExpoUrl(manual.trim())} />
            <button className="btn small" disabled={!manual.trim()} onClick={() => setExpoUrl(manual.trim())}>Show QR</button>
          </div>
          <div className="apple-row">
            <button className="btn small" onClick={() => startEas(p)}><i className="codicon codicon-cloud" /> Build with EAS</button>
          </div>
          <p className="muted small">Runs <code>npx eas-cli build --platform ios</code> — Expo's own cloud build service. It needs your Expo account (you sign in in the terminal); builds for real devices or the App Store also need an Apple Developer account.</p>
        </>
      )}
      {p.kind === "spm" && p.swiftPortable && (
        <>
          <div className="apple-row">
            <button className="btn small" disabled={!s.swiftAvailable} onClick={() => swiftLocal(p)}><i className="codicon codicon-play" /> Build &amp; test Swift package locally</button>
          </div>
          <p className="muted small">
            {s.swiftAvailable ? "Uses the Swift toolchain on this computer (`swift build`, `swift test`). " : "`swift` was not found on PATH — install Swift for Windows or Linux from swift.org to build here. "}
            No UIKit / SwiftUI / AppKit imports were found. Apps that use those frameworks still need the cloud macOS build below.
          </p>
        </>
      )}
    </Section>
  );
}

function Qr({ text }: { text: string }) {
  const q = useMemo(() => { try { return encodeQr(text); } catch { return null; } }, [text]);
  if (!q) return <p className="muted small">That address is too long for a QR code.</p>;
  const n = q.size + 8;
  return (
    <div className="apple-qr">
      <svg viewBox={`0 0 ${n} ${n}`} width={196} height={196} shapeRendering="crispEdges" role="img" aria-label={`QR code for ${text}`}>
        <rect width={n} height={n} fill="#fff" />
        <path d={qrPath(q)} fill="#000" />
      </svg>
      <code className="small">{text}</code>
      <button className="link small" onClick={() => navigator.clipboard.writeText(text).then(() => toast("Copied"))}>Copy address</button>
    </div>
  );
}

// ---------- workflow generator ----------

function Generator() {
  const s = useAppleUi();
  const p = selectedProject(s)!;
  const o = s.opts!;
  const r = recipe(p);
  const upd = (patch: Partial<WorkflowOptions>) => ui({ opts: { ...o, ...patch }, preview: null, confirmOverwrite: false });
  const check = (key: keyof WorkflowOptions, label: string, enabled: boolean, hint?: string) =>
    enabled && (
      <label className="apple-check" title={hint}>
        <input type="checkbox" checked={!!o[key]} onChange={(e) => upd({ [key]: e.target.checked } as Partial<WorkflowOptions>)} /> {label}
      </label>
    );
  const targets = enabledTargets(p, o);
  const exists = s.preview?.existing != null;
  const same = exists && s.preview!.existing === s.preview!.text;

  return (
    <Section title="CLOUD BUILD WORKFLOW">
      <p className="muted small">Writes <code>{WORKFLOW_PATH}</code> for GitHub Actions (<code>runs-on: macos-latest</code>), tailored to this {p.label} project.</p>
      <div className="apple-grid">
        <label>Scheme / app<input value={o.scheme} onChange={(e) => upd({ scheme: e.target.value })} list="apple-schemes" /></label>
        <datalist id="apple-schemes">{["auto", ...p.schemes].map((x) => <option key={x} value={x} />)}</datalist>
        <label>Configuration
          <select value={o.configuration} onChange={(e) => upd({ configuration: e.target.value as "Debug" | "Release" })}><option>Debug</option><option>Release</option></select>
        </label>
        <label>Xcode version<input value={o.xcode} onChange={(e) => upd({ xcode: e.target.value })} placeholder="latest-stable" title="Passed to maxim-lobanov/setup-xcode: latest-stable, latest, 16.2, …" /></label>
        <label>Also run on push to<input value={o.pushBranch} onChange={(e) => upd({ pushBranch: e.target.value })} placeholder="(manual runs only)" title="Every push uses macOS minutes; leave empty to run only when you start it." /></label>
      </div>
      <div className="apple-checks">
        {check("simulator", "iOS Simulator build (.app, no signing)", !!r.simulator)}
        {check("macos", "macOS build (unsigned .app + .dmg)", !!r.macos)}
        {check("tests", `Tests — ${testLabel(p)}`, !!r.test)}
        {check("device", "Signed iOS archive (.ipa) — Apple Developer account", !!r.device)}
        {o.device && check("testflight", "TestFlight upload option (App Store Connect API key)", !!r.device)}
        {check("notarize", "Sign + notarize macOS build when secrets are set — Developer ID", !!r.macos && !!r.macosApp)}
      </div>
      {!targets.length && <p className="muted small">Select at least one build target.</p>}
      <div className="apple-row">
        <button className="btn small primary" disabled={!targets.length} onClick={() => previewWorkflow(true)}><i className="codicon codicon-diff" /> Preview</button>
        {s.preview && !same && (
          <button className={`btn small${s.confirmOverwrite ? " danger" : ""}`} onClick={() => writeWorkflow(s.confirmOverwrite)}>
            {exists ? (s.confirmOverwrite ? "Confirm: overwrite existing file" : "Overwrite existing workflow…") : "Write workflow file"}
          </button>
        )}
        {s.preview && same && <span className="muted small">The file on disk already matches.</span>}
      </div>
      {s.preview && (
        <details className="apple-preview">
          <summary className="small">Preview ({s.preview.text.split("\n").length} lines){exists && !same ? " — differs from the file on disk (see the diff tab)" : ""}</summary>
          <pre>{s.preview.text}</pre>
        </details>
      )}
    </Section>
  );
}

// ---------- signing checklist ----------

function SigningChecklist({ opts }: { opts: WorkflowOptions }) {
  const repo = useAppleUi((s) => s.repo);
  const secrets = requiredSecrets(opts);
  const win = navigator.userAgent.includes("Windows");
  const b64 = (f: string) => (win ? `[Convert]::ToBase64String([IO.File]::ReadAllBytes("${f}")) | Set-Clipboard` : `base64 -i ${f} | tr -d '\\n'`);
  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast("Copied"));
  return (
    <Section title="SIGNING CHECKLIST (GITHUB SECRETS)">
      <p className="muted small">
        Signed builds need an <b>Apple Developer Program</b> membership. Add these as repository secrets — Cepheus never uploads them;
        GitHub encrypts secrets in your browser on its settings page.
      </p>
      {repo && (
        <button className="link small" onClick={() => openUrl(`https://github.com/${repo.owner}/${repo.repo}/settings/secrets/actions`)}>
          <i className="codicon codicon-link-external" /> Open {repo.owner}/{repo.repo} › Settings › Secrets and variables › Actions
        </button>
      )}
      <ul className="apple-secrets">
        {secrets.map((x) => (
          <li key={x.name}>
            <code>{x.name}</code> <button className="icon-btn small" title="Copy name" onClick={() => copy(x.name)}><i className="codicon codicon-copy" /></button>
            <div className="muted small">{x.what}</div>
            {x.how === "p12" && <div className="muted small">Copy as base64: <code>{b64("cert.p12")}</code></div>}
            {x.how === "b64" && <div className="muted small">Copy as base64: <code>{b64("profile.mobileprovision")}</code></div>}
          </li>
        ))}
      </ul>
      <details>
        <summary className="small">Make the .p12 without a Mac (OpenSSL)</summary>
        <pre className="apple-pre">{`openssl genrsa -out dist.key 2048
openssl req -new -key dist.key -out dist.csr -subj "/CN=Your Name/C=US"
# Upload dist.csr at developer.apple.com › Certificates › +
# (Apple Distribution, or Developer ID Application for macOS),
# download the .cer, then:
openssl x509 -inform der -in distribution.cer -out dist.pem
openssl pkcs12 -export -legacy -inkey dist.key -in dist.pem -out cert.p12`}</pre>
        <p className="muted small"><code>-legacy</code> is for OpenSSL 3, so macOS can import the file. Keep <code>dist.key</code> private.</p>
      </details>
      {opts.device && <p className="muted small">Your app target's Release signing must match the certificate and profile (manual signing, the profile's team and bundle ID).</p>}
    </Section>
  );
}

// ---------- GitHub: run & monitor ----------

const ICON: Record<string, string> = { success: "pass", failure: "error", cancelled: "circle-slash", skipped: "debug-step-over", timed_out: "watch" };
const statusIcon = (status: string, conclusion: string | null) =>
  status === "completed" ? ICON[conclusion ?? ""] ?? "circle-outline" : status === "in_progress" ? "sync" : "clock";
const statusClass = (status: string, conclusion: string | null) =>
  status !== "completed" ? "st-run" : conclusion === "success" ? "st-ok" : conclusion === "failure" || conclusion === "timed_out" ? "st-bad" : "";

function Cloud() {
  const token = useStore((s) => s.settings.githubToken);
  const s = useAppleUi();
  const p = selectedProject(s);
  const [confirmCommit, setConfirmCommit] = useState(false);
  const run = s.runs.find((r) => r.id === s.runId) ?? null;

  // Live status: poll the selected run while it is active, and the list while anything is running.
  useEffect(() => {
    const active = run && run.status !== "completed";
    const anyActive = s.runs.some((r) => r.status !== "completed");
    if (!active && !anyActive) return;
    const t = setInterval(() => { refreshRuns(); if (active) refreshRunDetails(); }, active ? 5000 : 10000);
    return () => clearInterval(t);
  }, [run?.id, run?.status, s.runs.map((r) => r.status).join()]);

  if (!token) {
    return (
      <Section title="RUN ON GITHUB">
        <p className="muted small">Connect GitHub (token with the <code>repo</code> and <code>workflow</code> scopes) to start and watch cloud builds.</p>
        <button className="btn small" onClick={() => set({ sidebar: "github", view: "editor" })}><i className="codicon codicon-github" /> Connect GitHub</button>
      </Section>
    );
  }
  if (!s.repo) {
    return (
      <Section title="RUN ON GITHUB">
        <p className="muted small">This folder has no GitHub remote. Publish it from the GitHub view first; the build runs from the code on GitHub.</p>
        <button className="btn small" onClick={() => set({ sidebar: "github", view: "editor" })}>Open GitHub view</button>
      </Section>
    );
  }
  const wf = s.wf;
  const ready = wf?.local != null && !wf.dirty && wf.remote === "same";
  return (
    <>
      <Section title={`RUN ON GITHUB · ${s.repo.owner}/${s.repo.repo}`} right={<button className="icon-btn small" title="Refresh" onClick={() => { refreshWorkflowStatus(); refreshRuns(); }}><i className="codicon codicon-refresh" /></button>}>
        <Usage />
        {wf && wf.local == null && <p className="muted small">No <code>{WORKFLOW_PATH}</code> yet — generate it above.</p>}
        {wf && wf.local != null && !ready && (
          <>
            <p className="muted small">
              {wf.dirty ? "The workflow has uncommitted changes. " : wf.remote === "missing" ? `The workflow is committed but not on GitHub (branch ${wf.branch}). ` : wf.remote === "different" ? "GitHub has a different version of the workflow on this branch. " : ""}
              GitHub can only run a workflow that is committed and pushed. To start it from GitHub's Actions page it must also be on the default branch{s.repoInfo ? ` (${s.repoInfo.default_branch})` : ""}.
            </p>
            <div className="apple-row">
              {wf.dirty && !confirmCommit && <button className="btn small" onClick={() => setConfirmCommit(true)}>Commit workflow…</button>}
              {wf.dirty && confirmCommit && (
                <>
                  <button className="btn small primary" onClick={() => { setConfirmCommit(false); commitWorkflow(); }}>Commit only {WORKFLOW_PATH}</button>
                  <button className="btn small" onClick={() => setConfirmCommit(false)}>Cancel</button>
                </>
              )}
              {!wf.dirty && <button className="btn small primary" onClick={() => syncNow().then(refreshWorkflowStatus)}><i className="codicon codicon-sync" /> Sync (pull + push)</button>}
            </div>
          </>
        )}
        {p && s.opts && wf?.local != null && <StartForm ready={ready} />}
      </Section>
      <Section title="RUNS">
        {!s.runs.length && <p className="muted small">No runs of {WORKFLOW_PATH.split("/").pop()} yet.</p>}
        {s.runs.map((r) => <RunRow key={r.id} r={r} active={r.id === s.runId} />)}
      </Section>
      {run && <RunDetails run={run} />}
    </>
  );
}

function Usage() {
  const info = useAppleUi((s) => s.repoInfo);
  return (
    <p className="muted small">
      {info ? (info.private ? "Private repository: " : "Public repository: ") : ""}
      GitHub's policy is that standard GitHub-hosted runners are free for public repositories; for private repositories, minutes beyond your plan's included
      amount are billed, and macOS minutes cost more than Linux minutes.{" "}
      <button className="link small" onClick={() => openUrl(BILLING_URL)}>GitHub billing docs</button>
    </p>
  );
}

function StartForm({ ready }: { ready: boolean }) {
  const s = useAppleUi();
  const p = selectedProject(s)!;
  const o = s.opts!;
  const targets = enabledTargets(p, o);
  const [inp, setInp] = useState({ scheme: o.scheme, configuration: o.configuration as string, target: (targets[0] ?? "simulator") as BuildTarget, tests: true, testflight: false });
  const [busy, setBusy] = useState(false);
  useEffect(() => setInp((x) => ({ ...x, scheme: o.scheme, target: targets.includes(x.target) ? x.target : (targets[0] ?? "simulator") })), [o.scheme, targets.join()]);
  // Read the workflow's own inputs, so the form matches the committed file even if the options changed since.
  const local = s.wf?.local ?? "";
  const hasTests = /\n {6}tests:\n/.test(local);
  const hasTf = /\n {6}testflight:\n/.test(local);
  const fileTargets = (local.match(/\n {6}target:\n(?: {8}.*\n)*? {8}options: \[([^\]]*)\]/)?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const choices = (fileTargets.length ? fileTargets : targets) as BuildTarget[];
  const label: Record<BuildTarget, string> = { simulator: "iOS Simulator", device: "iPhone (signed .ipa)", macos: "macOS" };
  return (
    <div className="apple-start">
      <div className="apple-grid">
        <label>Scheme<input value={inp.scheme} onChange={(e) => setInp({ ...inp, scheme: e.target.value })} /></label>
        <label>Configuration
          <select value={inp.configuration} onChange={(e) => setInp({ ...inp, configuration: e.target.value })}><option>Debug</option><option>Release</option></select>
        </label>
        <label>Target
          <select value={inp.target} onChange={(e) => setInp({ ...inp, target: e.target.value as BuildTarget })}>
            {choices.map((t) => <option key={t} value={t}>{label[t] ?? t}</option>)}
          </select>
        </label>
      </div>
      <div className="apple-checks">
        {hasTests && <label className="apple-check"><input type="checkbox" checked={inp.tests} onChange={(e) => setInp({ ...inp, tests: e.target.checked })} /> Run tests</label>}
        {hasTf && inp.target === "device" && <label className="apple-check"><input type="checkbox" checked={inp.testflight} onChange={(e) => setInp({ ...inp, testflight: e.target.checked })} /> Upload to TestFlight</label>}
      </div>
      <button className="btn small primary" disabled={!ready || busy} title={ready ? "" : "Commit and push the workflow first"}
        onClick={async () => { setBusy(true); await startBuild(inp, hasTests, hasTf); setBusy(false); }}>
        <i className="codicon codicon-cloud-upload" /> {busy ? "Starting…" : `Build on GitHub (${s.wf?.branch})`}
      </button>
    </div>
  );
}

function RunRow({ r, active }: { r: GhRun; active: boolean }) {
  return (
    <div className={`tree-row apple-run${active ? " active" : ""}`} onClick={() => selectRun(active ? null : r.id)} title={r.display_title}>
      <i className={`codicon codicon-${statusIcon(r.status, r.conclusion)} ${statusClass(r.status, r.conclusion)}`} />
      <span className="name">#{r.run_number} {r.display_title}</span>
      <span className="muted">{r.head_branch} · {fmtDuration(runDuration(r))}</span>
    </div>
  );
}

function RunDetails({ run }: { run: GhRun }) {
  const s = useAppleUi();
  const info = s.repoInfo;
  const active = run.status !== "completed";
  const failed = run.conclusion === "failure";
  const mins = jobMinutes(s.jobs);
  const current = (j: GhJob) => j.steps?.find((x) => x.status === "in_progress") ?? j.steps?.find((x) => x.conclusion === "failure") ?? j.steps?.[j.steps.length - 1];
  const logJob = s.jobs.find((j) => j.id === s.log?.jobId);
  const logStep = logJob?.steps?.find((x) => x.number === s.log?.step);

  return (
    <Section title={`RUN #${run.run_number}`} right={
      <span className="apple-actions">
        {active && <button className="icon-btn small" title="Cancel run" onClick={() => runAction(run.id, "cancel")}><i className="codicon codicon-debug-stop" /></button>}
        {!active && failed && <button className="icon-btn small" title="Re-run failed jobs" onClick={() => runAction(run.id, "rerun-failed-jobs")}><i className="codicon codicon-debug-restart" /></button>}
        {!active && <button className="icon-btn small" title="Re-run all jobs" onClick={() => runAction(run.id, "rerun")}><i className="codicon codicon-refresh" /></button>}
        <button className="icon-btn small" title="Open on GitHub" onClick={() => openUrl(run.html_url)}><i className="codicon codicon-link-external" /></button>
      </span>
    }>
      <p className="muted small">
        {active ? "Running for " : "Took "}{fmtDuration(runDuration(run))}
        {mins > 0 && <> · about {mins} runner minute{mins === 1 ? "" : "s"} (each job rounded up{info?.private ? "; billed for private repositories" : ""})</>}
      </p>
      {s.jobs.map((j) => (
        <div key={j.id} className="apple-job">
          <div className="tree-row" onClick={() => loadJobLog(j, null)} title="Show the full job log">
            <i className={`codicon codicon-${statusIcon(j.status, j.conclusion)} ${statusClass(j.status, j.conclusion)}`} />
            <span className="name"><b>{j.name}</b></span>
            <span className="muted">{j.started_at ? fmtDuration(Date.parse(j.completed_at ?? new Date().toISOString()) - Date.parse(j.started_at)) : "queued"}</span>
          </div>
          {j.steps?.map((st) => (
            <div key={st.number} className={`tree-row apple-step${st === current(j) ? " current" : ""}${s.log?.jobId === j.id && s.log.step === st.number ? " active" : ""}`}
              onClick={() => loadJobLog(j, st.number)}>
              <i className={`codicon codicon-${statusIcon(st.status, st.conclusion)} ${statusClass(st.status, st.conclusion)}`} />
              <span className="name">{st.name}</span>
            </div>
          ))}
        </div>
      ))}
      {s.log && (
        <div className="apple-log">
          <div className="apple-row">
            <span className="small"><b>{logJob?.name}</b>{logStep ? ` › ${logStep.name}` : " (full log)"}</span>
            <button className="icon-btn small" title="Close log" onClick={() => ui({ log: null })}><i className="codicon codicon-close" /></button>
          </div>
          {s.log.loading && <p className="muted small">Downloading log…</p>}
          {s.log.error && <p className="muted small">{s.log.error} {logJob && <button className="link small" onClick={() => openUrl(logJob.html_url)}>Open job on GitHub</button>}</p>}
          {!s.log.loading && s.log.text && <pre>{(logStep ? sliceStepLog(s.log.text, logStep) : s.log.text).slice(-60000)}</pre>}
          {logStep && s.log.text && <p className="muted small">Step lines are matched by time stamps, so neighbouring lines may appear.</p>}
        </div>
      )}
      <div className="section-title"><span>ARTIFACTS · {s.artifacts.length}</span></div>
      {!s.artifacts.length && <p className="muted small">{active ? "Artifacts appear when jobs finish." : "This run produced no artifacts."}</p>}
      {s.artifacts.map((a) => (
        <div key={a.id} className="tree-row">
          <i className="codicon codicon-package" />
          <span className="name">{a.name}</span>
          <span className="muted">{(a.size_in_bytes / 1048576).toFixed(1)} MB</span>
          <button className="btn small" disabled={a.expired} title={a.expired ? "Expired" : `Download into artifacts/${run.id}/`} onClick={() => downloadArtifact(a, run.id)}>
            {a.expired ? "Expired" : "Download"}
          </button>
        </div>
      ))}
      {s.artifacts.some((a) => a.name.includes("simulator")) && (
        <p className="muted small">A Simulator .app runs only in the iOS Simulator (part of Xcode on a Mac). To try the app on your own iPhone you need a signed build (Apple Developer account) — or Expo Go for Expo projects.</p>
      )}
    </Section>
  );
}
