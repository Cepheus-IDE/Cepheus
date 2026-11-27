import { set, useStore } from "../store";

export default function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }))}>
          <i className={`codicon codicon-${t.kind === "error" ? "error" : "info"}`} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
