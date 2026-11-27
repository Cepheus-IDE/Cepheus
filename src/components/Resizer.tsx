import { useCallback, useEffect, useState } from "react";

export function usePersistentSize(key: string, initial: number) {
  const [v, setV] = useState<number>(() => {
    const s = Number(localStorage.getItem("cepheus." + key));
    return Number.isFinite(s) && s > 0 ? s : initial;
  });
  useEffect(() => {
    localStorage.setItem("cepheus." + key, String(v));
  }, [key, v]);
  // Switching profiles rewrites the stored sizes; pick them up live.
  useEffect(() => {
    const reload = () => {
      const s = Number(localStorage.getItem("cepheus." + key));
      setV(Number.isFinite(s) && s > 0 ? s : initial);
    };
    window.addEventListener("cepheus:layout", reload);
    return () => window.removeEventListener("cepheus:layout", reload);
  }, [key, initial]);
  return [v, setV] as const;
}

export function Resizer({ dir, onDelta }: { dir: "x" | "y"; onDelta: (d: number) => void }) {
  const onDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      let last = dir === "x" ? e.clientX : e.clientY;
      const move = (ev: MouseEvent) => {
        const cur = dir === "x" ? ev.clientX : ev.clientY;
        onDelta(cur - last);
        last = cur;
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        document.body.classList.remove("resizing");
      };
      document.body.classList.add("resizing");
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [dir, onDelta]
  );
  return <div className={`resizer resizer-${dir}`} onMouseDown={onDown} />;
}
