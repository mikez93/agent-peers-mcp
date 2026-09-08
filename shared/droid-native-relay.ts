// Factory's native TUI remains the frontend; this relay owns one IPC daemon.
// Verified against Droid 0.213.0. This is Factory's internal daemon protocol,
// not ACP. Never log frames: initialize/load requests carry authentication.
import { randomUUID } from "node:crypto";
import type { WakePromptClient } from "./droid-launcher.ts";

export interface DroidFrame {
  id?: string;
  method?: string;
  type?: string;
  jsonrpc?: string;
  factoryApiVersion?: string;
  factoryProtocolVersion?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { code: number; message: string };
  [key: string]: unknown;
}

export class DroidNativeRelay implements WakePromptClient {
  private template?: DroidFrame;
  private daemonReady = false;
  private authenticated = false;
  private authentication?: DroidFrame;
  private readonly authId = randomUUID();
  private waiting: DroidFrame[] = [];
  private sessionRequestId?: string;
  private sessionId?: string;
  private prepared = false;
  private bound = false;
  private working = false;
  private stopped = false;
  private readonly humanTurns = new Map<string, string>();
  private readonly deletions = new Map<string, string>();
  private readonly startedTurns = new Set<string>();
  private wake?: { requestId: string; turnId: string; resolve: () => void; reject: (error: Error) => void };

  constructor(private readonly io: {
    toDaemon: (frame: DroidFrame) => void;
    toTui: (frame: DroidFrame) => void;
    prepareSession: (frame: DroidFrame) => Promise<DroidFrame>;
    sessionReady: (sessionId: string) => Promise<void>;
    onCancel: () => void;
  }) {}

  get isBusy(): boolean {
    return this.stopped || !this.bound || this.working || this.humanTurns.size > 0 || !!this.wake;
  }

  async fromTui(frame: DroidFrame): Promise<void> {
    if (this.stopped) return;
    if (!frame.method) { this.send(frame); return; } // Native permission/AskUser response.
    this.template = { jsonrpc: frame.jsonrpc, factoryApiVersion: frame.factoryApiVersion,
      factoryProtocolVersion: frame.factoryProtocolVersion };
    if (frame.method === "daemon.change_working_directory") {
      this.io.toTui({ ...this.envelope(), type: "response", id: frame.id,
        error: { code: -32602, message: "A managed peer keeps its launch directory. Exit and start droidpeer in the other directory." } });
      return;
    }
    if (frame.method === "daemon.initialize_session" || frame.method === "daemon.load_session") {
      const id = frame.params?.sessionId;
      if (this.prepared) {
        this.io.toTui({ ...this.envelope(), type: "response", id: frame.id,
          error: { code: -32602, message: "This peer launcher loads one session once. Exit and use droidpeer --resume SESSION_ID to reload or switch sessions." } });
        return;
      }
      this.prepared = true;
      this.sessionId = id;
      this.sessionRequestId = frame.id;
      frame = await this.io.prepareSession(frame);
      if (this.stopped) return;
    }
    if (frame.method === "daemon.add_user_message" && !frame.params?.skipAgentLoop) {
      if (typeof frame.id !== "string") {
        throw new Error("Factory native prompt omitted its request identity");
      }
      const requestId = frame.id;
      const messageId = typeof frame.params?.messageId === "string" ? frame.params.messageId : randomUUID();
      frame = { ...frame, params: { ...frame.params, messageId } };
      this.humanTurns.set(requestId, messageId);
    }
    if (frame.method === "daemon.resolve_queued_user_message" && frame.params?.action === "delete"
      && typeof frame.id === "string" && typeof frame.params?.requestId === "string") {
      this.deletions.set(frame.id, frame.params.requestId);
    }
    if (frame.method === "daemon.interrupt_session" && this.wake) this.io.onCancel();
    if (frame.method === "daemon.close_session" && frame.params?.sessionId === this.sessionId) this.bound = false;
    // The native child trusts its parent and skips authenticate. A standalone
    // daemon does not. Reuse only the credential the TUI supplies for this run.
    if (!this.authentication && !this.authenticated && typeof frame.params?.token === "string") {
      this.authentication = { ...this.envelope(), type: "request", id: this.authId,
        method: "daemon.authenticate", params: { token: frame.params.token, caller: "cli" } };
      if (this.daemonReady) this.io.toDaemon(this.authentication);
    }
    this.send(frame);
  }

  async fromDaemon(frame: DroidFrame): Promise<void> {
    if (this.stopped) return;
    // Daemon's out-of-band IPC ready message precedes its request listener.
    if (!frame.method && !frame.id && typeof frame.pid === "number" && typeof frame.version === "string") {
      this.daemonReady = true;
      if (this.authentication) this.io.toDaemon(this.authentication);
      return;
    }
    if (frame.id === this.authId) {
      this.authentication = undefined;
      if (frame.error) throw new Error(`Factory native daemon authentication failed: ${frame.error.message}`);
      this.authenticated = true;
      for (const queued of this.waiting.splice(0)) this.io.toDaemon(queued);
      return;
    }
    if (frame.id === this.sessionRequestId) {
      if (frame.error) throw new Error(`Factory native session failed: ${frame.error.message}`);
      const id = frame.result?.sessionId ?? this.sessionId;
      if (typeof id !== "string" || !id) throw new Error("Factory native session omitted its identity");
      this.sessionId = id;
      this.io.toTui(frame);
      await this.io.sessionReady(id);
      if (!this.stopped) this.bound = true;
      return;
    }
    if (frame.error && frame.id) this.humanTurns.delete(frame.id);
    if (frame.id && this.deletions.has(frame.id)) {
      const target = this.deletions.get(frame.id)!;
      this.deletions.delete(frame.id);
      if (!frame.error) this.discardTurn(target);
    }
    if (this.wake && frame.id === this.wake.requestId) {
      if (frame.error) {
        const pending = this.wake;
        this.wake = undefined;
        pending.reject(new Error(`Factory native wake rejected: ${frame.error.message}`));
      }
      return; // Completion comes from the exact turn notification, not this ack.
    }
    if (frame.method === "daemon.session_notification" && this.sessionId && frame.params?.sessionId === this.sessionId) {
      const notification = frame.params?.notification;
      if (notification?.type === "session_closed" || notification?.type === "session_process_exited") {
        this.close();
        throw new Error("Factory native session closed; use droidpeer --resume to reopen it with a fresh peer binding");
      }
      if (notification?.type === "create_message" && typeof notification.message?.id === "string") {
        const id = notification.message.id;
        if ([...this.humanTurns.values()].includes(id) || this.wake?.turnId === id) this.startedTurns.add(id);
      }
      if (notification?.type === "droid_working_state_changed") this.working = notification.newState !== "idle";
      if (notification?.type === "queued_messages_discarded") {
        if (typeof notification.requestId === "string") this.discardTurn(notification.requestId);
        else {
          // Factory omits requestId when discarding several queued messages.
          // Already-materialized turns remain protected until completion.
          for (const [id, turn] of this.humanTurns) if (!this.startedTurns.has(turn)) this.discardTurn(id);
          if (this.wake && !this.startedTurns.has(this.wake.turnId)) this.discardTurn(this.wake.requestId);
        }
      }
      if (notification?.type === "agent_turn_completed") {
        for (const [requestId, turnId] of this.humanTurns) {
          // Native end-of-turn input can be coalesced into the running turn.
          // Factory persists each outcome but emits only the outer completion.
          if (turnId === notification.turnId || this.startedTurns.has(turnId)) {
            this.humanTurns.delete(requestId);
            this.startedTurns.delete(turnId);
          }
        }
        this.startedTurns.delete(notification.turnId);
        if (this.wake && notification.turnId === this.wake.turnId) {
          if (notification.reason === "cancelled") this.io.onCancel();
          const pending = this.wake;
          this.wake = undefined;
          pending.resolve();
        }
      }
    }
    this.io.toTui(frame);
  }

  prompt(sessionId: string, text: string): Promise<void> {
    if (sessionId !== this.sessionId || this.isBusy) return Promise.reject(new Error("Factory native session is not idle"));
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const turnId = randomUUID();
      this.wake = { requestId, turnId, resolve, reject };
      try {
        this.io.toDaemon({ ...this.envelope(), type: "request", id: requestId,
          method: "daemon.add_user_message", params: { sessionId, messageId: turnId, text, queuePlacement: "end_of_loop" } });
      } catch (error) {
        this.wake = undefined;
        reject(error);
      }
    });
  }

  close(): void {
    this.stopped = true;
    this.bound = false;
    this.authentication = undefined;
    this.waiting = [];
    this.template = undefined;
    this.humanTurns.clear();
    this.deletions.clear();
    this.startedTurns.clear();
    this.wake?.reject(new Error("Factory native host stopped"));
    this.wake = undefined;
  }

  private send(frame: DroidFrame): void {
    if (this.authenticated) this.io.toDaemon(frame);
    else this.waiting.push(frame);
  }

  private discardTurn(requestId: string): void {
    const turn = this.humanTurns.get(requestId);
    if (turn) this.startedTurns.delete(turn);
    this.humanTurns.delete(requestId);
    if (this.wake?.requestId === requestId) {
      const pending = this.wake;
      this.wake = undefined;
      this.io.onCancel();
      pending.resolve();
    }
  }

  private envelope(): DroidFrame {
    return { jsonrpc: this.template?.jsonrpc, factoryApiVersion: this.template?.factoryApiVersion,
      factoryProtocolVersion: this.template?.factoryProtocolVersion };
  }
}
