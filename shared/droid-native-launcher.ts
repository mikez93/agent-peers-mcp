import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { DroidLaunchClaimStore } from "./droid-launch-claims.ts";
import { defaultPeerName } from "./peer-identity.ts";
import { buildDroidMcpServer, ClaimBoundDroidWakeMetadataSource, DroidWakeController, DroidLauncherUsageError, type DroidLauncherOptions } from "./droid-launcher.ts";
import { DroidNativeRelay, type DroidFrame } from "./droid-native-relay.ts";
import { acquireDroidSession } from "./droid-session-owner.ts";

// Keep Factory's UI, permission prompts, history renderer and key handling.
// Only the daemon is detached: its process group contains our owned engines
// and MCP children, and can be shut down without touching another session.
export async function runNativeDroidLauncher(opts: DroidLauncherOptions, signal: AbortSignal): Promise<number> {
  const root = process.env.AGENT_PEERS_DROID_STATE_DIR ?? join(homedir(), ".agent-peers-droid");
  const claims = new DroidLaunchClaimStore({ rootDir: root });
  const saved = opts.sessionId ? await claims.readSession(opts.sessionId) : null;
  // Factory canonicalizes cwd (notably /tmp -> /private/tmp on macOS).
  const cwd = await realpath(opts.sessionId && opts.cwdExplicit === false && saved ? saved.cwd : opts.cwd);
  if (opts.sessionId && opts.settingsExplicit) {
    throw new DroidLauncherUsageError("Native resume retains saved settings. Omit model/reasoning/autonomy options and change them in Droid's native UI, or use --headless.");
  }
  if (opts.sessionId && saved && cwd !== await realpath(saved.cwd)) {
    throw new DroidLauncherUsageError("Native resume retains the saved working directory. Start a new droidpeer session to change repositories.");
  }
  const peerName = await defaultPeerName(cwd, "droid", opts.peerName ?? saved?.peer_name
    ?? saved?.requested_peer_name ?? (process.env.PEER_NAME || undefined));
  const claim = await claims.createClaim({ cwd, requestedPeerName: peerName, previousPeerId: saved?.peer_id });
  const server = buildDroidMcpServer({ claimId: claim.claim_id, stateRoot: root, peerName });
  // Factory lets filesystem MCP names override session names. A per-launch
  // name prevents a user-configured agent-peers entry stealing this binding.
  const mcpServer = { ...server, name: `agent-peers-${claim.claim_id.replace(/-/g, "").slice(0, 16)}`,
    env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])) };
  const binary = opts.droidCommand ?? "droid";
  let daemon: ChildProcess | undefined;
  let tui: ChildProcess | undefined;
  let relay: DroidNativeRelay | undefined;
  let controller: DroidWakeController | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  let finish!: (code: number) => void;
  const done = new Promise<number>((resolve) => { finish = resolve; });
  let failure: Error | undefined;
  const stop = (code: number, error?: Error) => {
    if (abort.signal.aborted) return;
    failure = error;
    abort.abort();
    relay?.close();
    finish(code);
  };
  const onAbort = () => stop(0);
  signal.addEventListener("abort", onAbort, { once: true });
  const send = (child: ChildProcess | undefined, frame: DroidFrame) => {
    if (!child?.connected) throw new Error("Factory native IPC connection closed");
    child.send(JSON.stringify(frame), (error) => { if (error) stop(1, new Error("Factory native IPC send failed")); });
  };
  let sessionPrepared = false;
  let releaseSession: (() => Promise<void>) | undefined;
  let actualSessionId: string | undefined;
  try {
    if (signal.aborted) return 0;
    if (opts.sessionId) releaseSession = await acquireDroidSession(root, opts.sessionId);
    daemon = spawn(binary, ["daemon", "--listen", "ipc"], {
      cwd, detached: true, serialization: "json", stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    // Do not corrupt the native display or leak daemon frames/logs into it.
    daemon.stderr?.resume();
    const args = ["--cwd", cwd];
    if (opts.sessionId) args.push("--resume", opts.sessionId);
    tui = spawn(binary, args, { cwd, serialization: "json", stdio: ["inherit", "inherit", "inherit", "ipc"] });
    relay = new DroidNativeRelay({
      toDaemon: (frame) => send(daemon, frame),
      toTui: (frame) => send(tui, frame),
      prepareSession: async (frame) => {
        if (!sessionPrepared) {
          if (typeof frame.params?.sessionId !== "string") throw new Error("Factory native session request omitted its ID");
          if (!releaseSession) releaseSession = await acquireDroidSession(root, frame.params.sessionId);
          sessionPrepared = true;
          deadline = setTimeout(() => stop(1, new Error("Factory native session or peer binding timed out")), 90_000);
        }
        const params = { ...frame.params };
        // Session-scoped MCP overrides keep deployment targets untouched.
        params.mcpServers = [...(params.mcpServers ?? []).filter((item: { name?: string }) => item.name !== "agent-peers"), mcpServer];
        if (frame.method === "daemon.initialize_session") {
          if (opts.model) params.modelId = opts.model;
          if (opts.reasoningEffort) params.reasoningEffort = opts.reasoningEffort;
          if (opts.autonomyLevel) params.autonomyLevel = opts.autonomyLevel.replace(/^auto-/, "");
        }
        return { ...frame, params };
      },
      sessionReady: async (sessionId) => {
        if (opts.sessionId && sessionId !== opts.sessionId) throw new Error("Factory resumed a different session");
        await claims.waitForBinding(claim.claim_id, { timeoutMs: opts.claimTimeoutMs, signal: abort.signal });
        await claims.setSessionId(claim.claim_id, sessionId);
        actualSessionId = sessionId;
        if (abort.signal.aborted) return;
        if (deadline) clearTimeout(deadline);
        controller = new DroidWakeController(sessionId, relay!, new ClaimBoundDroidWakeMetadataSource(claims, claim.claim_id, root),
          () => stop(1, new Error("Factory native peer wake failed; resume the session to recover")));
      },
      onCancel: () => controller?.suppressCurrentUnread(),
    });
    // Preserve input order across asynchronous session preparation. Daemon
    // notifications remain independent so permission/turn events cannot block
    // behind a binding wait whose MCP startup requires those events.
    let input = Promise.resolve();
    tui.on("message", (message) => {
      input = input.then(() => relay!.fromTui(parseFrame(message))).catch((error) => stop(1, safeError(error)));
    });
    daemon.on("message", (message) => {
      void Promise.resolve().then(() => relay!.fromDaemon(parseFrame(message))).catch((error) => stop(1, safeError(error)));
    });
    for (const child of [tui, daemon]) {
      child.on("error", () => stop(1, new Error("Unable to start Factory Droid")));
      child.on("exit", (code) => stop(child === tui ? code ?? 1 : 1));
      child.on("disconnect", () => {
        const timer = setTimeout(() => { if (!abort.signal.aborted) stop(1, new Error("Factory native IPC disconnected")); }, 250);
        timer.unref();
      });
    }
    let polling = false;
    interval = setInterval(() => {
      if (!controller || polling || abort.signal.aborted) return;
      polling = true;
      void controller.pollOnce().catch((error) => stop(1, safeError(error))).finally(() => { polling = false; });
    }, opts.pollMs);
    const code = await done;
    if (failure) throw failure;
    return code;
  } finally {
    signal.removeEventListener("abort", onAbort);
    abort.abort();
    relay?.close();
    if (interval) clearInterval(interval);
    if (deadline) clearTimeout(deadline);
    try { await Promise.all([shutdown(tui, false), shutdown(daemon, true)]); }
    finally {
      await claims.removeClaim(claim.claim_id);
      await releaseSession?.();
      if (actualSessionId) console.error(`Resume this peer: droidpeer --resume ${actualSessionId}`);
    }
  }
}

function parseFrame(message: unknown): DroidFrame {
  try {
    const frame = typeof message === "string" ? JSON.parse(message) : message;
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error();
    return frame as DroidFrame;
  } catch { throw new Error("Factory emitted an invalid native IPC frame"); }
}

function safeError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Factory native host failed");
}

async function shutdown(child: ChildProcess | undefined, group: boolean): Promise<void> {
  if (!child?.pid) return;
  const pid = child.pid;
  const kill = (signal: NodeJS.Signals) => {
    try { if (group) process.kill(-pid, signal); else if (child.exitCode === null && child.signalCode === null) child.kill(signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      // macOS may report EPERM during a disappearing process-group race.
      // Only accept disappearance after a successful process-table read.
      const result = spawnSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" });
      if (result.status === 0 && !result.stdout.split("\n").some((line) => {
        const [processId, groupId] = line.trim().split(/\s+/).map(Number);
        return (group ? groupId : processId) === pid;
      })) return;
      throw new Error(`Could not stop owned Factory ${group ? "process group" : "process"} ${pid}: ${(error as NodeJS.ErrnoException).code}`);
    }
  };
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve() : new Promise<void>((resolve) => child.once("exit", () => resolve()));
  kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { kill("SIGKILL"); } catch (error) { reject(error); return; }
      timer = setTimeout(() => reject(new Error(`Owned Factory process ${pid} did not exit after SIGKILL`)), 2000);
    }, 2000);
  });
  try { await Promise.race([exited, timeout]); } finally { clearTimeout(timer!); }
  // The daemon can exit before its engine/MCP descendants. They belong solely
  // to this detached group and must not keep a stale peer alive after close.
  if (group) kill("SIGKILL");
}
