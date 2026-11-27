import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { errMsg } from "../lib/api";
import { GitBranch, gitOp, gitx } from "../lib/gitApi";
import { get, toast } from "../store";

/** Quick branch picker (status bar branch click / "Git: Checkout to…"), styled like the command palette. */
export const useBranchPicker = create<{ open: boolean }>(() => ({ open: false }));
export const openBranchPicker = () => useBranchPicker.setState({ open: true });

interface Item { key: string; label: string; detail: string; icon: string; run: () => void }

export default function BranchPicker() {
  const open = useBranchPicker((s) => s.open);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [from, setFrom] = useState<string | null>(null); // "create from" step: the new branch name
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ(""); setSel(0); setFrom(null);
    const ws = get().workspace;
    if (ws) gitx.refs(ws).then((r) => { setBranches(r.branches); setTags(r.tags.map((t) => t.name)); }).catch((e) => toast(errMsg(e), "error"));
    setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  if (!open) return null;
  const close = () => useBranchPicker.setState({ open: false });
  const term = q.trim();
  const t = term.toLowerCase();
  const checkout = (b: GitBranch) => gitOp(`Switched to ${b.name}`, ["checkout", b.remote ? b.name.split("/").slice(1).join("/") : b.name]);

  let items: Item[];
  if (from !== null) {
    items = [
      ...branches.map((b) => ({ key: b.name, label: b.name, detail: b.subject, icon: b.remote ? "cloud" : "git-branch" })),
      ...tags.map((n) => ({ key: "tag:" + n, label: n, detail: "tag", icon: "tag" })),
    ]
      .filter((i) => !t || i.label.toLowerCase().includes(t))
      .map((i) => ({ ...i, run: () => gitOp(`Switched to ${from}`, ["checkout", "-b", from, i.label]) }));
    if (term && !items.length) items = [{ key: "rev", label: term, detail: "commit / ref", icon: "git-commit", run: () => gitOp(`Switched to ${from}`, ["checkout", "-b", from, term]) }];
  } else {
    const valid = /^[^\s~^:?*[\\]+$/.test(term);
    items = [
      { key: "+new", label: term && valid ? `Create new branch "${term}"` : "Create new branch…", detail: "from current HEAD", icon: "add", run: () => term && valid ? gitOp(`Switched to ${term}`, ["checkout", "-b", term]) : toast("Type the new branch name first") },
      { key: "+from", label: term && valid ? `Create new branch "${term}" from…` : "Create new branch from…", detail: "", icon: "git-branch-create", run: () => { if (term && valid) { setFrom(term); setQ(""); setSel(0); } else toast("Type the new branch name first"); } },
      ...branches
        .filter((b) => !b.current && (!t || b.name.toLowerCase().includes(t)))
        .map((b) => ({ key: b.name, label: b.name, detail: `${b.remote ? "remote" : ""}${b.ahead || b.behind ? ` ${b.behind}↓ ${b.ahead}↑` : ""} · ${b.subject}`, icon: b.remote ? "cloud" : "git-branch", run: () => checkout(b) })),
      ...tags.filter((n) => !t || n.toLowerCase().includes(t)).map((n) => ({ key: "tag:" + n, label: n, detail: "tag (detached)", icon: "tag", run: () => gitOp(`Checked out ${n}`, ["checkout", n]) })),
    ];
  }
  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    if (it.key !== "+from") close();
    it.run();
  };

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={q}
          placeholder={from !== null ? `Create "${from}" from: select a branch, tag or type a commit` : "Select a branch or tag to checkout, or type a new branch name"}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); choose(sel); }
          }}
        />
        <div className="palette-list">
          {items.map((it, i) => (
            <div key={it.key} className={`palette-item ${i === sel ? "sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => choose(i)}>
              <i className={`codicon codicon-${it.icon}`} />
              <span className="label">{it.label}</span>
              <span className="detail">{it.detail}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
