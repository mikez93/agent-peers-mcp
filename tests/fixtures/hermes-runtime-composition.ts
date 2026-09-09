// Synthetic authenticated host for real stdio composition tests only.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HermesConversationContext } from "../../shared/hermes-conversation-context.ts";
import { startHermesConversationRuntime } from "../../shared/hermes-conversation-runtime.ts";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const root = process.env.AGENT_PEERS_CWD!;
let starts = 0;
const start = StdioServerTransport.prototype.start;
StdioServerTransport.prototype.start = async function (this: StdioServerTransport) {
  starts++;
  await start.call(this);
};
await startHermesConversationRuntime({
  createHostBridge: scope => {
    const saved = join(root, "host-contexts.json");
    const contexts = new Map<string, Readonly<HermesConversationContext>>(
      existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) : [],
    );
    return {
      async observe(context) {
        contexts.set(context.conversation_id, context);
        writeFileSync(saved, JSON.stringify([...contexts]), { mode: 0o600 });
        return { context, lifecycle_generation: 1, observed_at: Date.now(), state: "live",
          end_reason: null, busy: false, queued: false, compacting: false };
      },
      async inventory() {
        if (process.env.FIXTURE_HOST_MODE === "fail") throw new Error("fixture_host_unavailable");
        if (process.env.FIXTURE_HOST_MODE === "stop") {
          process.emit("SIGTERM");
          return new Promise(() => {});
        }
        return { ...scope, observed_at: Date.now(), inventory_complete: true,
          observations: [...contexts.values()].map(context => ({
            context, lifecycle_generation: 1, state: "live" as const, end_reason: null,
          })) };
      },
      async admit(request) {
        appendFileSync(join(root, "host-admissions.jsonl"), JSON.stringify(request) + "\n", { mode: 0o600 });
        return { ...request, state: "accepted" };
      },
      async reconcile(request) { return { ...request, state: "accepted" }; },
      async close() { writeFileSync(join(root, "host-closed"), JSON.stringify({ starts }), { mode: 0o600 }); },
    };
  },
});
