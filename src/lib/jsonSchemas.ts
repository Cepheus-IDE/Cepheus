//! Shared registry for Monaco JSON schemas. `setDiagnosticsOptions` replaces the whole list, so
//! every feature goes through here and keeps the others' schemas.

import { monaco } from "./monaco";

export function registerJsonSchema(uri: string, fileMatch: string[], schema: object) {
  const json = monaco.languages.json.jsonDefaults;
  const cur = json.diagnosticsOptions;
  const schemas = (cur.schemas ?? []).filter((s) => s.uri !== uri);
  schemas.push({ uri, fileMatch, schema });
  json.setDiagnosticsOptions({
    ...cur,
    validate: true,
    allowComments: true,
    trailingCommas: "ignore",
    enableSchemaRequest: false,
    schemas,
  });
}
