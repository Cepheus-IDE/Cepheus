// Promise-based confirm dialog (the webview has no usable window.confirm). Mounts its own root on
// first use, so callers need no JSX: `if (!(await confirmDialog({...}))) return;`
import { useEffect, useRef } from "react";
import { createRoot, Root } from "react-dom/client";

interface Opts { title: string; message?: string; confirmLabel?: string; danger?: boolean }

let root: Root | null = null;

export function confirmDialog(opts: Opts): Promise<boolean> {
  if (!root) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  const r = root;
  return new Promise((resolve) => {
    const done = (v: boolean) => { r.render(null); resolve(v); };
    r.render(<Confirm {...opts} onDone={done} />);
  });
}

function Confirm({ title, message, confirmLabel = "OK", danger, onDone }: Opts & { onDone: (v: boolean) => void }) {
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => ok.current?.focus(), []);
  return (
    <div className="overlay confirm-overlay" onMouseDown={() => onDone(false)}>
      <div className="modal confirm-dialog" role="alertdialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onDone(false); } }}>
        <div className="confirm-body">
          <i className={`codicon codicon-${danger ? "warning" : "question"}`} aria-hidden="true" />
          <div>
            <div className="confirm-title">{title}</div>
            {message && <div className="muted small">{message}</div>}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={() => onDone(false)}>Cancel</button>
          <button ref={ok} className={`btn primary ${danger ? "danger" : ""}`} onClick={() => onDone(true)}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
