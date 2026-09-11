#!/usr/bin/env bun
// Start native Factory Droid chat (or a headless ACP host) with peer wake.

const VERSION = "0.2.0";
export {};
const argv = process.argv.slice(2);
const USAGE = "droidpeer [options] | droidpeer --resume <session-id> [options] | droidpeer start [peer-name] [cwd] [options] | droidpeer resume <session-id> [peer-name] [cwd] [options]";

if (argv.length === 1 && ["-v", "-V", "--version"].includes(argv[0]!)) {
  console.log(VERSION);
  process.exit(0);
}

if (argv.includes("--help") || argv.includes("-h")) {
  console.log("bin: ~/.local/bin/droidpeer");
  console.log("description: Start or resume native Factory Droid chat with Agent Peers wake.");
  console.log(`usage: ${USAGE}`);
  console.log("default: native interactive Droid in a terminal; ACP headless host when input/output is redirected.");
  console.log("alias: droid-peer accepts the same arguments.");
  console.log("options:");
  console.log("  --headless                 Use the ACP host without native chat");
  console.log("  --resume, -r SESSION_ID    Resume an exact Factory session (also: resume SESSION_ID)");
  console.log("  --model ID                 New native / ACP model (env: DROID_PEER_MODEL)");
  console.log("  --reasoning-effort LEVEL   New native / ACP effort (env: DROID_PEER_REASONING_EFFORT)");
  console.log("  --autonomy-level LEVEL     low|medium|high or ACP value (default: high; env: DROID_PEER_AUTONOMY_LEVEL)");
  console.log("  --name NAME                Override AGENTS.md persona-repo-droid default");
  console.log("  --cwd, -C DIR              Working directory (default: current directory)");
  console.log("  --droid PATH               Droid executable (default: PATH lookup)");
  console.log("  --poll-ms MS               Inbox metadata poll interval (default: 1000)");
  console.log("  --claim-timeout-ms MS      MCP binding deadline (default: 15000)");
  console.log("native resume: retains saved directory/model/reasoning; managed autonomy defaults to high.");
  console.log("examples[4]:");
  console.log("  - droidpeer");
  console.log("  - droidpeer --resume <session-id>");
  console.log("  - droidpeer start reviewer ~/code/service");
  console.log("  - droidpeer resume <session-id> reviewer ~/code/service");
  process.exit(0);
}

const { DroidLauncherUsageError, parseDroidLauncherArgs, runDroidLauncher } = await import("./shared/droid-launcher.ts");
const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());

try {
  const opts = parseDroidLauncherArgs(argv);
  if (!opts.headless && process.stdin.isTTY && process.stdout.isTTY) {
    const { runNativeDroidLauncher } = await import("./shared/droid-native-launcher.ts");
    process.exit(await runNativeDroidLauncher(opts, abort.signal));
  }
  const code = await runDroidLauncher(opts, {
    onReady: ({ peerId, peerName, sessionId }) => {
      console.log("droid_peer:");
      console.log(`  name: ${peerName}`);
      console.log(`  peer_id: ${peerId}`);
      console.log(`  session_id: ${sessionId}`);
      console.log("  status: wakeable");
    },
    onWakeError: (error) => {
      console.error(`droidpeer wake failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  }, abort.signal);
  process.exit(code);
} catch (error) {
  console.log(`error: ${error instanceof Error ? error.message : String(error)}`);
  console.log(`help: ${USAGE}`);
  process.exit(error instanceof DroidLauncherUsageError ? 2 : 1);
}
