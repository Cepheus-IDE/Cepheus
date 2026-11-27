/** In-page folder/file picker for server mode (browses the served folder through `read_dir`). */
import type { Backend } from "../backend/types";

interface Opts {
  directory: boolean;
  title?: string;
  start: string;
  root: string;
  save?: boolean;
  defaultName?: string;
}

const css = `
.cw-pick-bg{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100000;display:flex;align-items:center;justify-content:center;font:13px system-ui,sans-serif}
.cw-pick{width:min(560px,92vw);max-height:80vh;display:flex;flex-direction:column;background:#1f1f1f;color:#ddd;border:1px solid #3a3a3a;border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,.5)}
.cw-pick h3{margin:0;padding:12px 14px;font-size:14px;font-weight:600;border-bottom:1px solid #333}
.cw-pick .cw-path{padding:8px 14px;color:#aaa;word-break:break-all;border-bottom:1px solid #333}
.cw-pick ul{list-style:none;margin:0;padding:4px 0;overflow:auto;flex:1;min-height:160px}
.cw-pick li{padding:5px 14px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cw-pick li:hover,.cw-pick li.sel{background:#2d4f7c}
.cw-pick .cw-row{display:flex;gap:8px;padding:10px 14px;border-top:1px solid #333;align-items:center}
.cw-pick input{flex:1;background:#141414;color:#ddd;border:1px solid #444;border-radius:4px;padding:5px 8px}
.cw-pick button{background:#333;color:#eee;border:1px solid #555;border-radius:4px;padding:5px 12px;cursor:pointer}
.cw-pick button.pri{background:#0e639c;border-color:#0e639c}
.cw-pick .cw-note{color:#999;font-size:12px;padding:0 14px 8px}`;

export function pickOnServer(backend: Backend, o: Opts): Promise<string | null> {
  return new Promise((resolve) => {
    if (!document.getElementById("cw-pick-css")) {
      const st = document.createElement("style");
      st.id = "cw-pick-css";
      st.textContent = css;
      document.head.appendChild(st);
    }
    const sep = o.root.includes("\\") ? "\\" : "/";
    const norm = (p: string) => p.replace(/[\\/]+$/, "");
    const bg = document.createElement("div");
    bg.className = "cw-pick-bg";
    bg.innerHTML = `<div class="cw-pick" role="dialog"><h3></h3><div class="cw-path"></div><ul></ul>
      <div class="cw-note">Cepheus Web can only open files inside the served folder.</div>
      <div class="cw-row">${o.save ? '<input placeholder="File name">' : '<span style="flex:1"></span>'}
      <button class="cancel">Cancel</button><button class="pri ok"></button></div></div>`;
    const $ = <T extends Element>(s: string) => bg.querySelector(s) as T;
    $<HTMLElement>("h3").textContent = o.title || (o.directory ? "Open Folder" : o.save ? "Save As" : "Open File");
    $<HTMLButtonElement>(".ok").textContent = o.directory ? "Select Folder" : o.save ? "Save" : "Open";
    const input = o.save ? $<HTMLInputElement>("input") : null;
    if (input) input.value = o.defaultName ?? "";
    let cur = norm(o.start || o.root);
    let selected: string | null = null;
    const done = (v: string | null) => {
      bg.remove();
      removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        done(null);
      }
    };
    addEventListener("keydown", onKey, true);
    const render = async () => {
      selected = null;
      $<HTMLElement>(".cw-path").textContent = cur;
      const ul = $<HTMLUListElement>("ul");
      ul.textContent = "Loading…";
      let ents: { name: string; path: string; isDir: boolean }[] = [];
      try {
        ents = await backend.invoke("read_dir", { path: cur });
      } catch (e) {
        ul.textContent = String(e);
        return;
      }
      ul.textContent = "";
      const add = (label: string, fn: () => void, dbl?: () => void) => {
        const li = document.createElement("li");
        li.textContent = label;
        li.onclick = () => {
          ul.querySelectorAll("li.sel").forEach((x) => x.classList.remove("sel"));
          li.classList.add("sel");
          fn();
        };
        if (dbl) li.ondblclick = dbl;
        ul.appendChild(li);
      };
      if (norm(cur).toLowerCase() !== norm(o.root).toLowerCase()) {
        add("📁 ..", () => {}, () => {
          cur = cur.slice(0, Math.max(cur.lastIndexOf("/"), cur.lastIndexOf("\\")));
          render();
        });
      }
      for (const e of ents) {
        if (o.directory && !e.isDir) continue;
        add(
          (e.isDir ? "📁 " : "📄 ") + e.name,
          () => {
            selected = e.path;
            if (input && !e.isDir) input.value = e.name;
          },
          () => {
            if (e.isDir) {
              cur = norm(e.path);
              render();
            } else done(e.path);
          },
        );
      }
    };
    $<HTMLButtonElement>(".cancel").onclick = () => done(null);
    $<HTMLButtonElement>(".ok").onclick = () => {
      if (o.save) {
        const name = input?.value.trim();
        if (name) done(cur + sep + name);
      } else if (o.directory) done(selected ?? cur);
      else if (selected) done(selected);
    };
    bg.onclick = (e) => {
      if (e.target === bg) done(null);
    };
    document.body.appendChild(bg);
    render();
  });
}
