// "Ask AI" for the database client: starts an agent task with the selected connection/schema
// (and the current SQL) as context. The agent uses db_schema / db_query / db_execute.
import { newSession, sendMessage } from "../agent";
import { set as setApp } from "../../store";
import { connById } from "./store";
import { KIND_LABEL } from "./types";

export interface AiContext { conn?: string; database?: string; schema?: string; table?: string; sql?: string; error?: string }

export async function askDbAi(prompt: string, ctx: AiContext) {
  const text = prompt.trim();
  if (!text) return;
  const c = connById(ctx.conn);
  const lines: string[] = [text, ""];
  if (c) {
    lines.push(
      `Database context: connection "${c.name}" (${KIND_LABEL[c.kind] ?? c.kind}${c.production ? ", PRODUCTION" : ""}${c.readOnly ? ", read-only" : ""})` +
        `${ctx.database ? `, database "${ctx.database}"` : c.database ? `, database "${c.database}"` : ""}${ctx.schema ? `, schema "${ctx.schema}"` : ""}${ctx.table ? `, table "${ctx.table}"` : ""}.`,
    );
    lines.push("Use db_schema to inspect it, db_query for read-only checks (EXPLAIN for performance), and db_execute for DDL/DML I need to approve.");
  } else {
    lines.push("No database connection is selected; call db_list_connections first.");
  }
  if (ctx.sql?.trim()) lines.push("", "Current SQL:", "```sql", ctx.sql.trim().slice(0, 12000), "```");
  if (ctx.error) lines.push("", "Last error:", "```", ctx.error.slice(0, 4000), "```");
  const sess = newSession();
  setApp({ agentOpen: true });
  await sendMessage(sess.id, lines.join("\n"), null);
}
