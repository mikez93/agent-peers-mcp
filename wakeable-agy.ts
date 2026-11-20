#!/usr/bin/env bun
// Host Antigravity (`agy acp`) headlessly as a wakeable Agent Peers peer.

const VERSION = "0.1.0";
export {};
const argv = process.argv.slice(2);
const USAGE = "agypeer [start [peer-name] [cwd]] [options] | agypeer resume <session-id> [peer-name] [cwd] [options]";

if (argv.length === 1 && ["-v", "-V", "--version"].includes(argv[0]!)) {
  console.log(VERSION);
  process.exit(0);
}

if (argv.includes("--help") || argv.includes("-h")) {
  console.log("bin: ~/.local/bin/agypeer");
  console.log("description: Host a headless Antigravity session that Agent Peers mail can wake.");
  console.log(`usage: ${USAGE}`);
  console.log("default: always headless (ACP); talk to it through Agent Peers. Interactive `agy` is unaffected.");
  console.log("options:");
  console.log("  --model ID                 Model for a new session (default: gemini-4-neon; env: AGY_PEER_MODEL)");
  console.log("  --thinking LEVEL           low|medium|high|xhigh (default: high; env: AGY_PEER_THINKING)");
  console.log("  --mode MODE                default|accept-edits|auto|plan (default: accept-edits; env: AGY_PEER_MODE)");
  console.log("  --name NAME                Override AGENTS.md persona-repo-antigravity default");
  console.log("  --cwd, -C DIR              Working directory (default: current directory)");
  console.log("  --agy PATH                 agy executable (default: PATH lookup)");
  console.log("  --poll-ms MS               Inbox metadata poll interval (default: 1000)");
  console.log("  --claim-timeout-ms MS      MCP binding deadline (default: 15000)");
  console.log("mode accept-edits: Antigravity edits files without asking and asks before running commands;");
  console.log("  anything it asks about is cancelled, because nobody is there to answer. --mode auto also runs commands, destructive ones included.");
  console.log("resume: keeps the session's model unless --model or --thinking is given.");
  console.log("examples[3]:");
  console.log("  - agypeer");
  console.log("  - agypeer start reviewer ~/code/service --thinking medium");
  console.log("  - agypeer resume <session-id>");
  process.exit(0);
}

const { DroidLauncherUsageError, runDroidLauncher } = await import("./shared/droid-launcher.ts");
const { AGY_LAUNCHER_PROFILE, AgySignedOutError, parseAgyLauncherArgs } = await import("./shared/agy-profile.ts");
const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());

try {
  const opts = parseAgyLauncherArgs(argv);
  const code = await runDroidLauncher(opts, {
    profile: AGY_LAUNCHER_PROFILE,
    onReady: ({ peerId, peerName, sessionId }) => {
      console.log("antigravity_peer:");
      console.log(`  name: ${peerName}`);
      console.log(`  peer_id: ${peerId}`);
      console.log(`  session_id: ${sessionId}`);
      console.log("  status: wakeable");
    },
    onWakeError: (error) => {
      console.error(`agypeer wake failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  }, abort.signal);
  process.exit(code);
} catch (error) {
  console.log(`error: ${error instanceof Error ? error.message : String(error)}`);
  if (!(error instanceof AgySignedOutError)) console.log(`help: ${USAGE}`);
  process.exit(error instanceof DroidLauncherUsageError ? 2 : 1);
}
