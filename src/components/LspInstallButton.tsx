import { useState } from "react";
import { useStore } from "../store";
import { installLanguageServer, useMissingServers } from "../lib/lsp";

/** Status bar action "Install Pyright" when the active file's language server isn't on PATH. */
export default function LspInstallButton() {
  const language = useStore((s) => s.language);
  const spec = useMissingServers((s) => s[language]);
  const [busy, setBusy] = useState<string | null>(null);
  if (!spec) return null;
  if (!spec.install) {
    return (
      <span className="lsp-pill lsp-missing" title={`No ${spec.name} found on PATH. Configure its command in Settings → Language Servers.`}>
        <i className="codicon codicon-warning" /> {spec.name} not installed
      </span>
    );
  }
  return (
    <button
      className="lsp-install"
      title={`Install the ${spec.name} language server: ${spec.install}`}
      disabled={busy === language}
      onClick={() => {
        setBusy(language);
        installLanguageServer(language).finally(() => setTimeout(() => setBusy(null), 4000));
      }}
    >
      <i className="codicon codicon-cloud-download" /> Install {spec.name}
    </button>
  );
}
