//! Monaco's TypeScript worker plus the refactoring APIs it doesn't expose: applicable refactors
//! (extract function/constant, convert…), their edits, and organize imports.
// @ts-ignore — untyped ESM entry inside monaco-editor
import { initialize, TypeScriptWorker } from "monaco-editor/esm/vs/language/typescript/ts.worker";

const FORMAT = { indentSize: 2, tabSize: 2, convertTabsToSpaces: true, insertSpaceAfterCommaDelimiter: true, insertSpaceAfterSemicolonInForStatements: true, insertSpaceBeforeAndAfterBinaryOperators: true, insertSpaceAfterKeywordsInControlFlowStatements: true, insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true, semicolons: "ignore" };
const PREFS = { allowTextChangesInNewFiles: false, providePrefixAndSuffixTextForRename: true, includeCompletionsForModuleExports: true, quotePreference: "auto" };

const Base: new (ctx: unknown, createData: unknown) => object = TypeScriptWorker;

class CepheusTsWorker extends Base {
  async getRefactors(fileName: string, start: number, end: number, triggerReason?: "invoked" | "implicit") {
    try {
      return (this as any).getLanguageService().getApplicableRefactors(fileName, { pos: start, end }, PREFS, triggerReason ?? "invoked");
    } catch {
      return [];
    }
  }
  async getRefactorEdits(fileName: string, start: number, end: number, refactor: string, action: string, format?: object) {
    try {
      return (this as any).getLanguageService().getEditsForRefactor(fileName, { ...FORMAT, ...format }, { pos: start, end }, refactor, action, PREFS) ?? null;
    } catch {
      return null;
    }
  }
  async organizeImportsEdits(fileName: string, format?: object) {
    try {
      return (this as any).getLanguageService().organizeImports({ type: "file", fileName }, { ...FORMAT, ...format }, PREFS);
    } catch {
      return [];
    }
  }
}

// The imported module installs its own handler; replace it (same pattern: first message boots the server).
self.onmessage = () => {
  initialize((ctx: unknown, createData: unknown) => new CepheusTsWorker(ctx, createData));
};
