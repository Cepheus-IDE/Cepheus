//! TODO tree: TODO / FIXME / HACK / NOTE / XXX comments across the workspace, grouped by file.

import { api, SearchMatch } from "../api";
import { useToolbox } from "./state";

export const TODO_TAGS = ["TODO", "FIXME", "HACK", "XXX", "NOTE"] as const;
export type TodoTag = (typeof TODO_TAGS)[number];
export interface TodoItem { path: string; line: number; col: number; tag: TodoTag; text: string }

/** The tag must follow a comment marker on the same line, so identifiers like `TODO_LIST` don't count. */
const IN_COMMENT = /(?:\/\/|\/\*|^\s*\*|#|<!--|^\s*--|;;|%|\{\/\*)[^\n]*?\b(TODO|FIXME|HACK|XXX|NOTE)\b(?:\([^)]*\))?:?\s*(.*)$/;

export function parseTodo(m: SearchMatch): TodoItem | null {
  const r = m.text.match(IN_COMMENT);
  if (!r) return null;
  const text = r[2].replace(/\s*(?:\*\/|-->|\*\/\})\s*$/, "").trim();
  return { path: m.path, line: m.line, col: m.col, tag: r[1] as TodoTag, text };
}

export async function scanTodos(ws: string): Promise<TodoItem[]> {
  const matches = await api.search(ws, {
    query: String.raw`\b(TODO|FIXME|HACK|XXX|NOTE)\b`,
    isRegex: true,
    caseSensitive: true,
    wholeWord: false,
    maxResults: 5000,
  });
  const seen = new Set<string>();
  const items: TodoItem[] = [];
  for (const m of matches) {
    const key = `${m.path}:${m.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = parseTodo(m);
    if (t) items.push(t);
  }
  useToolbox.setState({ todoCount: items.filter((t) => t.tag !== "NOTE").length });
  return items;
}
