import { defaultPeerName } from "./shared/peer-identity.ts";

const [cwd, harness] = process.argv.slice(2);
if (!cwd || !harness) {
  console.error("Usage: bun peer-name.ts <cwd> <harness>");
  process.exit(2);
}
try {
  console.log(defaultPeerName(cwd, harness, process.env.PEER_NAME || undefined));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
