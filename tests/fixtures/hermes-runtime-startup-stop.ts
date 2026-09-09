import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHermesConversationRuntime } from "../../shared/hermes-conversation-runtime.ts";

let starts = 0;
const original = StdioServerTransport.prototype.start;
StdioServerTransport.prototype.start = async function (this: StdioServerTransport) {
  starts++;
  await original.call(this);
};
await startHermesConversationRuntime({
  resolveGitRoot: async () => {
    process.emit("SIGTERM");
    await Bun.sleep(20);
    return null;
  },
});
console.log(JSON.stringify({ starts }));
process.exit(0);
