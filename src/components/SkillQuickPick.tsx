// Agent composer "Skills" quick-pick: inserts "Use the <name> skill: " into the prompt. Also applies
// the prefill queued by "Skills: Run Skill…" (src/lib/skills.ts runSkill) when a new task opens.
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { refreshCustomizations, useCustomizations } from "../lib/agentPlatform";
import { showSkills, takeSkillPrefill, withSkillPrefix } from "../lib/skills";

export default function SkillQuickPick({ sessionId, text, setText }: { sessionId: string; text: string; setText: (t: string) => void }) {
  const ws = useStore((s) => s.workspace);
  const skills = useCustomizations((c) => c.data.skills);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const p = takeSkillPrefill(sessionId);
    if (p) setText(p + text);
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    refreshCustomizations(true); // pick up skills installed since the last refresh
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, ws]);

  const query = q.trim().toLowerCase();
  const list = skills.filter((s) => !query || s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query));
  const pick = (name: string) => {
    setText(withSkillPrefix(text, name));
    setOpen(false);
    setQ("");
  };

  return (
    <div className="skill-qp" ref={root}>
      <button className={`chip ${open ? "on" : ""}`} onClick={() => setOpen((o) => !o)} title="Use a skill">
        <i className="codicon codicon-lightbulb" /> skills
      </button>
      {open && (
        <div className="skill-qp-pop">
          <input
            autoFocus
            placeholder="Filter skills"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "Enter" && list[0]) { e.preventDefault(); pick(list[0].name); }
            }}
          />
          <div className="skill-qp-list">
            {list.map((s) => (
              <button key={s.name} onClick={() => pick(s.name)} title={s.description}>
                <span className="name">{s.name}</span>
                <span className="muted small ellipsis">{s.description}</span>
              </button>
            ))}
            {!list.length && <div className="muted small skills-none">{skills.length ? "No matches." : "No skills enabled."}</div>}
          </div>
          <button className="skill-qp-manage" onClick={() => { setOpen(false); showSkills(skills.length ? "installed" : "gallery"); }}>
            <i className="codicon codicon-settings-gear" /> Manage skills…
          </button>
        </div>
      )}
    </div>
  );
}
