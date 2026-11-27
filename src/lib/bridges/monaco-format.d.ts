// Monaco's formatter conflict resolution (not part of the public API; used to honor the default formatter).
declare module "monaco-editor/esm/vs/editor/contrib/format/browser/format.js" {
  export const FormattingConflicts: {
    setFormatterSelector(selector: (formatters: any[], model: any, mode: number, kind: number) => Promise<any | undefined>): { dispose(): void };
  };
}
