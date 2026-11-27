/** One readline interface for the whole session: REPL lines, questions, secrets and Ctrl+C. */
import * as readline from "node:readline";
import { c } from "./ansi.js";

export class Input {
  readonly rl: readline.Interface;
  readonly tty: boolean;
  private waiter: ((line: string | null) => void) | null = null;
  private muted = false;
  private closed = false;
  /** Lines typed while nobody asked a question. */
  onLine: ((line: string) => void) | null = null;
  onSigint: (() => void) | null = null;
  onClose: (() => void) | null = null;

  constructor() {
    this.tty = !!process.stdin.isTTY;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: this.tty && !!process.stdout.isTTY,
      historySize: 500,
      prompt: "",
    });
    const rlAny = this.rl as any;
    const orig = rlAny._writeToOutput?.bind(rlAny);
    if (orig) {
      rlAny._writeToOutput = (s: string) => {
        if (!this.muted) return orig(s);
        if (s === "\r\n" || s === "\n" || s === "\r") return orig(s);
        const prompt: string = rlAny._prompt ?? "";
        if (prompt && s.startsWith(prompt)) return orig(prompt + "*".repeat((rlAny.line ?? "").length));
        return orig("*".repeat(s.length));
      };
    }
    this.rl.on("line", (line) => {
      const w = this.waiter;
      if (w) {
        this.waiter = null;
        w(line);
      } else this.onLine?.(line);
    });
    this.rl.on("SIGINT", () => this.onSigint?.());
    this.rl.on("close", () => {
      this.closed = true;
      const w = this.waiter;
      this.waiter = null;
      w?.(null);
      this.onClose?.();
    });
    if (!this.rl.terminal) {
      // Piped stdin: readline doesn't see Ctrl+C, the process gets SIGINT.
      process.on("SIGINT", () => this.onSigint?.());
    }
  }

  get isClosed() {
    return this.closed;
  }

  get asking() {
    return this.waiter !== null;
  }

  /** Shows the REPL prompt and waits for lines via `onLine`. */
  prompt(text: string) {
    if (this.closed) return;
    this.rl.setPrompt(text);
    this.rl.prompt();
  }

  ask(question: string): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    this.rl.setPrompt(question);
    this.rl.prompt();
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  async askSecret(question: string): Promise<string | null> {
    this.muted = this.rl.terminal;
    try {
      const v = await this.ask(question);
      const h = (this.rl as any).history as string[] | undefined;
      if (v && h && h[0] === v) h.shift(); // never keep secrets in the history
      return v;
    } finally {
      this.muted = false;
    }
  }

  /** Resolves a pending question with null (e.g. on Ctrl+C). */
  cancelAsk() {
    const w = this.waiter;
    this.waiter = null;
    if (w) {
      process.stdout.write("\n");
      w(null);
    }
  }

  async confirm(question: string, def = false): Promise<boolean> {
    const a = (await this.ask(`${question} ${c.gray(def ? "[Y/n]" : "[y/N]")} `))?.trim().toLowerCase();
    if (a == null || a === "") return def;
    return a === "y" || a === "yes";
  }

  /** Numbered choice; returns the index or null. */
  async choose(title: string, options: string[], def = 0): Promise<number | null> {
    process.stdout.write(`${title}\n`);
    options.forEach((o, i) => process.stdout.write(`  ${c.cyan(String(i + 1).padStart(2))}) ${o}\n`));
    for (;;) {
      const a = await this.ask(`Choose 1-${options.length} ${c.gray(`[${def + 1}]`)}: `);
      if (a == null) return null;
      const t = a.trim();
      if (!t) return def;
      const n = parseInt(t, 10);
      if (n >= 1 && n <= options.length) return n - 1;
      process.stdout.write(c.yellow(`Please enter a number between 1 and ${options.length}.\n`));
    }
  }

  close() {
    if (!this.closed) this.rl.close();
  }
}
