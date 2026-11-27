import { useEffect, useState } from "react";
import { useStore } from "../store";
import { fileIcon } from "../lib/paths";
import { iconFor, imageSync, loadImage } from "../lib/iconTheme";

/** File/folder icon: from the active file icon theme, else Cepheus' monogram. */
export default function FileIcon({ name, isDir = false, open = false }: { name: string; isDir?: boolean; open?: boolean }) {
  useStore((s) => s.iconThemeVersion);
  const path = iconFor(name, isDir, open);
  const [url, setUrl] = useState<string | null>(() => (path ? imageSync(path) : null));

  useEffect(() => {
    if (!path) return setUrl(null);
    const c = imageSync(path);
    if (c) return setUrl(c);
    let alive = true;
    loadImage(path).then((u) => alive && setUrl(u)).catch(() => alive && setUrl(null));
    return () => { alive = false; };
  }, [path]);

  if (path) return url ? <img className="ficon" src={url} alt="" draggable={false} /> : <span className="ficon" />;
  if (isDir) return null;
  return <span className="file-icon">{fileIcon(name).label}</span>;
}
