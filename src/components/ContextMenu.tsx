import { useEffect } from "react";

export interface MenuItem { label: string; icon?: string; onClick: () => void; danger?: boolean; separator?: boolean }

export default function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const top = Math.min(y, window.innerHeight - items.length * 28 - 16);
  const left = Math.min(x, window.innerWidth - 230);
  return (
    <div className="ctx-menu" style={{ top, left }} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={i}
            className={it.danger ? "danger" : ""}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            <i className={`codicon codicon-${it.icon ?? "blank"}`} />
            {it.label}
          </button>
        )
      )}
    </div>
  );
}
