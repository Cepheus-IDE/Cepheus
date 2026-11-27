import { useEffect, useRef, useState } from "react";
import { set, toast, useStore } from "../store";
import { editorRef, runInlineEdit } from "../lib/ai";
import { errMsg } from "../lib/api";

export default function InlineEdit() {
  const open = useStore((s) => s.inlineEditOpen);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState({ top: 120, left: 200 });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const ed = editorRef.current;
    if (!ed || !ed.getModel()) {
      set({ inlineEditOpen: false });
      toast("Open a file to use inline edit.");
      return;
    }
    const sel = ed.getSelection();
    const coords = sel ? ed.getScrolledVisiblePosition({ lineNumber: sel.startLineNumber, column: 1 }) : null;
    const rect = ed.getDomNode()!.getBoundingClientRect();
    setPos({ top: rect.top + (coords?.top ?? 40) - 46, left: rect.left + 60 });
    setText("");
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  if (!open) return null;
  const close = () => {
    set({ inlineEditOpen: false });
    editorRef.current?.focus();
  };
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await runInlineEdit(text.trim());
      close();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inline-edit" style={{ top: Math.max(50, pos.top), left: pos.left }}>
      <i className={`codicon codicon-${busy ? "loading codicon-modifier-spin" : "sparkle"}`} />
      <input
        ref={inputRef}
        value={text}
        disabled={busy}
        placeholder="Edit selection: describe the change… (Enter to apply, Esc to cancel)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") close();
        }}
        onBlur={() => !busy && close()}
      />
    </div>
  );
}
