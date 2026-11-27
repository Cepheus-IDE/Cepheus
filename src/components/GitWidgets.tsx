import { ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "../store";

/** Inline text prompt (the webview has no usable window.prompt). */
export interface Ask { label: string; placeholder?: string; initial?: string; submit: (v: string) => void }

export function AskRow({ ask, onClose }: { ask: Ask | null; onClose: () => void }) {
  const [v, setV] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { setV(ask?.initial ?? ""); setTimeout(() => ref.current?.select(), 0); }, [ask]);
  if (!ask) return null;
  return (
    <div className="git-ask">
      <div className="small muted">{ask.label}</div>
      <input
        ref={ref}
        autoFocus
        placeholder={ask.placeholder}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={onClose}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && v.trim()) { onClose(); ask.submit(v.trim()); }
        }}
      />
    </div>
  );
}

/** A button that asks for a second click before running a destructive action. */
export function ConfirmButton({ title, icon, confirmText, onConfirm, className = "" }: { title: string; icon: string; confirmText: string; onConfirm: () => void; className?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={`${className} ${armed ? "armed" : ""}`}
      title={armed ? confirmText : title}
      onClick={(e) => {
        e.stopPropagation();
        if (armed) { setArmed(false); onConfirm(); } else { setArmed(true); toast(`${confirmText} — click again to confirm`); }
      }}
    >
      <i className={`codicon codicon-${armed ? "warning" : icon}`} />
    </button>
  );
}

export function RefBadge({ r }: { r: string }): ReactNode {
  const head = r.startsWith("HEAD -> ");
  const name = head ? r.slice(8) : r.replace(/^tag: /, "");
  const kind = r.startsWith("tag: ") ? "tag" : r === "HEAD" ? "head" : /\//.test(name) && !head ? "remote" : "local";
  return (
    <span className={`ref-badge ref-${kind} ${head ? "ref-current" : ""}`} title={r}>
      <i className={`codicon codicon-${kind === "tag" ? "tag" : kind === "remote" ? "cloud" : "git-branch"}`} />{name}
    </span>
  );
}

export const copy = (text: string, what = "Copied") => navigator.clipboard.writeText(text).then(() => toast(what), () => toast("Clipboard unavailable", "error"));
