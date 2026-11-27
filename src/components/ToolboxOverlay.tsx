import { useEffect, useMemo, useRef, useState } from "react";
import { relative } from "../lib/paths";
import { useStore } from "../store";
import { dismissNotice, useToolbox } from "../lib/toolbox/state";
import { explainWithAgent, freePortWithToast, initToolbox, showToolbox } from "../lib/toolbox";
import { pasteClip, useClips } from "../lib/toolbox/clipboard";
import { togglePresenting } from "../lib/toolbox/present";
import { commitAnyway, dismissGuard } from "../lib/toolbox/secretGuard";
import { openFile } from "../lib/workspace";
import { join } from "../lib/paths";

/** Global Toolbox layer (mounted once in App): terminal notices, clipboard picker, presenting badge. */
export default function ToolboxOverlay() {
  useEffect(() => initToolbox(), []);
  const presenting = useToolbox((s) => s.presenting);
  return (
    <>
      <Notices />
      <ClipPicker />
      {presenting && (
        <button className="tb-presenting-badge" title="Presentation mode: secrets are masked. Click to stop." onClick={togglePresenting}>
          <span className="dot" /> Presenting
        </button>
      )}
    </>
  );
}

function Notices() {
  const notices = useToolbox((s) => s.notices);
  if (!notices.length) return null;
  return (
    <div className="tb-notices">
      {notices.map((n) => (
        <div key={n.id} className="tb-notice">
          <i className={`codicon codicon-${n.kind === "port" ? "plug" : "error"}`} />
          <span className="grow">{n.text}</span>
          {n.kind === "port" && n.port && (
            <>
              <button className="btn small primary" onClick={() => { dismissNotice(n.id); freePortWithToast(n.port!); }}>Free port {n.port}</button>
              <button className="btn small" onClick={() => { dismissNotice(n.id); showToolbox("ports"); }}>Ports…</button>
            </>
          )}
          {n.kind === "error" && n.output && (
            <button className="btn small primary" onClick={() => { dismissNotice(n.id); explainWithAgent(n.output!); }}>
              <i className="codicon codicon-sparkle" /> Explain with agent
            </button>
          )}
          <button className="icon-btn small" title="Dismiss" onClick={() => dismissNotice(n.id)}><i className="codicon codicon-close" /></button>
        </div>
      ))}
    </div>
  );
}

function ClipPicker() {
  const open = useToolbox((s) => s.clipPicker);
  const clips = useClips((s) => s.clips);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const f = q.trim().toLowerCase();
    return f ? clips.filter((c) => c.text.toLowerCase().includes(f) || c.source.toLowerCase().includes(f)) : clips;
  }, [clips, q]);
  useEffect(() => { if (open) { setQ(""); setSel(0); } }, [open]);
  useEffect(() => { list.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest" }); }, [sel]);
  if (!open) return null;
  const close = () => useToolbox.setState({ clipPicker: false });
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette tb-clip" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder={clips.length ? "Search clipboard history — Enter to paste" : "Copy or cut something in the editor first"}
          value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(shown.length - 1, s + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            else if (e.key === "Enter" && shown[sel]) { e.preventDefault(); pasteClip(shown[sel].text); }
            else if (/^[1-9]$/.test(e.key) && e.altKey && shown[Number(e.key) - 1]) { e.preventDefault(); pasteClip(shown[Number(e.key) - 1].text); }
          }}
        />
        <div className="tb-clip-list" ref={list}>
          {shown.map((c, i) => (
            <div key={c.at + c.text.slice(0, 20)} className={`tb-clip-item ${i === sel ? "sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => pasteClip(c.text)}>
              <pre>{c.text.length > 600 ? c.text.slice(0, 600) + "…" : c.text.replace(/\s+$/, "")}</pre>
              <div className="tb-clip-meta">
                {i < 9 && <span className="kbd">Alt+{i + 1}</span>}
                <span>{c.source || c.language}</span>
                <span>{c.text.split("\n").length} line{c.text.split("\n").length === 1 ? "" : "s"}</span>
                <span>{new Date(c.at).toLocaleTimeString()}</span>
              </div>
            </div>
          ))}
          {!shown.length && clips.length > 0 && <div className="tb-hint">No match.</div>}
        </div>
      </div>
    </div>
  );
}

/** Status bar toggle for presentation mode. */
export function PresentToggle() {
  const on = useToolbox((s) => s.presenting);
  return (
    <button className={on ? "tb-present-on" : ""} title={on ? "Stop presentation mode" : "Presentation mode: mask secrets, bigger font"} onClick={togglePresenting}>
      <i className={`codicon codicon-${on ? "eye-closed" : "screen-full"}`} />{on ? " Presenting" : ""}
    </button>
  );
}

/** Inline warning shown in the Git panel when the staged diff looks like it contains secrets. */
export function SecretGuardBanner({ onCommitAnyway }: { onCommitAnyway?: () => void }) {
  const guard = useToolbox((s) => s.guard);
  const ws = useStore((s) => s.workspace);
  if (!guard) return null;
  const { findings, envFiles } = guard;
  return (
    <div className="tb-guard">
      <div className="tb-guard-title"><i className="codicon codicon-shield" /> Commit held: this may leak secrets</div>
      {envFiles.map((f) => (
        <div key={f} className="tb-guard-item" onClick={() => ws && openFile(join(ws, f))}>
          <i className="codicon codicon-file" /> <span className="mono">{f}</span> <span className="muted">is an environment file — usually it belongs in .gitignore</span>
        </div>
      ))}
      {findings.slice(0, 12).map((f, i) => (
        <div key={i} className="tb-guard-item" title="Open" onClick={() => ws && openFile(join(ws, f.file), f.line, 1)}>
          <span className="mono">{relative(ws, f.file)}:{f.line}</span> <span className="muted">{f.kind}</span> <span className="mono tb-guard-preview">{f.preview}</span>
        </div>
      ))}
      {findings.length > 12 && <div className="muted small">…and {findings.length - 12} more</div>}
      <div className="row gap tb-guard-actions">
        <button className="btn small" onClick={dismissGuard}>Cancel</button>
        <span className="spacer" />
        <button className="btn small danger" onClick={() => commitAnyway(onCommitAnyway)}>Commit anyway</button>
      </div>
    </div>
  );
}
