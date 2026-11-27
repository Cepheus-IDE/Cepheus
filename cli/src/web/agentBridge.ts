/**
 * agent_send / agent_cancel / agent_approve / agent_reset / agent_steer on top of the CLI agent
 * core (`createSession`, `runAgentTurn`). Environment-agnostic (no `node:*` imports): the Node
 * server and the browser backend each pass their own ToolHost and event sink.
 */

export interface CoreLike {
  createSession: (...args: any[]) => any;
  runAgentTurn: (opts: any, emit: (ev: any) => void, signal?: AbortSignal) => Promise<any>;
  [k: string]: any;
}

interface SessionState {
  provider: string;
  workspace: string;
  session: any;
  running: boolean;
  abort: AbortController | null;
  queue: string[];
}

export interface AgentBridgeOptions {
  loadCore: () => Promise<CoreLike | null>;
  /** ToolHost for a workspace (absolute path or virtual root). */
  host: (workspace: string) => any;
  /** Sends one AgentEvent to the UI (`agent-event`). */
  emit: (ev: any) => void;
  /** NVIDIA key used when the user has none (server: NVIDIA_API_KEY env var). */
  defaultNvidiaKey?: () => string | undefined;
  /** Message when the core is missing. */
  coreMissing: string;
  /** Validates/normalizes the workspace (throws when not allowed). */
  checkWorkspace?: (ws: string) => string;
  /** Extra options merged into every runAgentTurn call (e.g. `mcp`). */
  extraOpts?: (workspace: string) => Record<string, any>;
}

let approvalCounter = 0;

export class AgentBridge {
  private sessions = new Map<string, SessionState>();
  private approvals = new Map<string, (ok: boolean) => void>();
  private core: Promise<CoreLike | null> | null = null;

  constructor(private o: AgentBridgeOptions) {}

  private loadCore() {
    this.core ??= this.o.loadCore().catch((e) => {
      console.warn("[cepheus web] agent core failed to load:", e);
      return null;
    });
    return this.core;
  }

  async send(req: any) {
    if (!req || typeof req.sessionId !== "string") throw new Error("Invalid request");
    let workspace = String(req.workspace ?? "").trim();
    if (!workspace) throw new Error("Open a folder first.");
    if (this.o.checkWorkspace) workspace = this.o.checkWorkspace(workspace);
    const config = { ...(req.config ?? {}) };
    if (config.provider === "nvidia" && !String(config.apiKey ?? "").trim()) {
      const k = this.o.defaultNvidiaKey?.();
      if (!k) {
        throw new Error(
          "No API key configured. The free built-in NVIDIA key ships only with the desktop app: add your own NVIDIA key (free at build.nvidia.com) or another provider in Settings.",
        );
      }
      config.apiKey = k;
    }
    if (!["openai", "nvidia"].includes(config.provider) && !String(config.apiKey ?? "").trim()) {
      throw new Error("No API key configured. Open Settings (gear icon) and add your API key.");
    }
    const core = await this.loadCore();
    if (!core) throw new Error(this.o.coreMissing);

    let st = this.sessions.get(req.sessionId);
    if (st && st.running) throw new Error("This agent is still working. Stop it first or wait for it to finish.");
    if (!st || st.provider !== config.provider || st.workspace !== workspace) {
      st = { provider: config.provider, workspace, session: core.createSession({ id: req.sessionId }), running: false, abort: null, queue: [] };
      this.sessions.set(req.sessionId, st);
    }
    const s = st;
    s.running = true;
    s.abort = new AbortController();
    const sid = req.sessionId;
    let finalStatus: string | null = null;
    const emit = (ev: any) => {
      if (!ev || typeof ev !== "object") return;
      if (ev.type === "textDelta") return; // the app renders full `text` events only
      if (ev.sessionId == null) ev = { ...ev, sessionId: sid };
      if (ev.type === "status" && ["idle", "stopped", "error"].includes(ev.status)) finalStatus = ev.status;
      if (ev.type === "approvalRequest" && ev.approvalId) seen.add(ev.approvalId);
      this.o.emit(ev);
    };
    const seen = new Set<string>();
    const approve = (r: any) =>
      new Promise<boolean>((resolve) => {
        const approvalId = r?.approvalId || `w${Date.now().toString(36)}${++approvalCounter}`;
        this.approvals.set(approvalId, resolve);
        s.abort?.signal.addEventListener("abort", () => {
          if (this.approvals.delete(approvalId)) resolve(false);
        });
        // The core may already have emitted the request; otherwise show it in the chat now.
        setTimeout(() => {
          if (!seen.has(approvalId) && this.approvals.has(approvalId)) {
            emit({ type: "approvalRequest", sessionId: sid, approvalId, callId: r?.callId ?? "", name: r?.name ?? "", args: r?.args ?? {} });
          }
        }, 0);
      });

    const opts = {
      ...req,
      sessionId: sid,
      session: s.session,
      workspace,
      config,
      host: this.o.host(workspace),
      approvalMode: req.approvalMode ?? "ask",
      planMode: req.mode === "plan" || !!req.planMode,
      context: req.context ?? undefined,
      customInstructions: req.customInstructions ?? undefined,
      agent: req.agent ?? undefined,
      approve,
      signal: s.abort.signal,
      /** Steering messages queued while the run is in progress (drained by the core). */
      takeSteering: () => s.queue.splice(0),
      steering: s.queue,
      ...(this.o.extraOpts?.(workspace) ?? {}),
    };
    // Runs in the background like the desktop command: agent_send returns immediately.
    void (async () => {
      try {
        await core.runAgentTurn(opts, emit, s.abort!.signal);
        if (!finalStatus) emit({ type: "status", sessionId: sid, status: s.abort?.signal.aborted ? "stopped" : "idle" });
      } catch (e) {
        if (s.abort?.signal.aborted) {
          if (!finalStatus) emit({ type: "status", sessionId: sid, status: "stopped" });
        } else if (finalStatus !== "error") {
          emit({ type: "error", sessionId: sid, message: e instanceof Error ? e.message : String(e) });
          emit({ type: "status", sessionId: sid, status: "error" });
        }
      } finally {
        s.running = false;
        s.queue.length = 0;
      }
    })();
    return null;
  }

  cancel(sessionId: string) {
    this.sessions.get(sessionId)?.abort?.abort();
    return null;
  }

  approve(approvalId: string, approved: boolean) {
    const r = this.approvals.get(approvalId);
    this.approvals.delete(approvalId);
    r?.(!!approved);
    return null;
  }

  reset(sessionId: string) {
    this.sessions.get(sessionId)?.abort?.abort();
    this.sessions.delete(sessionId);
    return null;
  }

  steer(sessionId: string, message: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || !s.running || s.abort?.signal.aborted) return false;
    const core = s.session;
    if (core && typeof core.steer === "function") {
      return !!core.steer(String(message ?? ""));
    }
    s.queue.push(String(message ?? ""));
    return true;
  }

  /** `agent_customizations`: instruction files, skills, custom agents and hooks of a workspace. */
  async customizations(workspace: string, mapPath: (p: string) => string = (p) => p) {
    const empty = { instructions: [], skills: [], agents: [], hooks: [] };
    let ws = String(workspace ?? "").trim();
    if (!ws) return empty;
    if (this.o.checkWorkspace) ws = this.o.checkWorkspace(ws);
    const core = await this.loadCore();
    if (typeof core?.loadCustomizations !== "function") return empty;
    const c = await core.loadCustomizations(this.o.host(ws));
    return {
      instructions: (c.instructions ?? []).map((i: any) => ({ ...i, path: mapPath(i.path) })),
      skills: (c.skills ?? []).map((s: any) => ({ ...s, dir: mapPath(s.dir) })),
      agents: (c.agents ?? []).map(({ body: _b, ...a }: any) => ({ ...a, path: mapPath(a.path) })),
      hooks: c.hooks ?? [],
    };
  }

  async oneshot(config: any, system: string, prompt: string, maxTokens?: number | null): Promise<string | undefined> {
    const core = await this.loadCore();
    const f = core?.aiOneshot ?? core?.oneshot;
    return typeof f === "function" ? f(config, system, prompt, maxTokens ?? 8000) : undefined;
  }

  disposeAll() {
    for (const s of this.sessions.values()) s.abort?.abort();
    for (const r of this.approvals.values()) r(false);
    this.approvals.clear();
  }
}
