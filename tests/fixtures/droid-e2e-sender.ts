// Manual live verifier for the real Factory ACP wake path. Not part of the
// default unit suite because it consumes a model turn and requires Droid auth.

import { createClient } from "../../shared/broker-client.ts";
import { readSharedSecret } from "../../shared/shared-secret.ts";

const [target, nonce, expectedReply] = process.argv.slice(2);
const port = process.env.AGENT_PEERS_PORT;
const secretPath = process.env.AGENT_PEERS_SECRET_PATH;
if (!target || !nonce || !expectedReply || !port || !secretPath) {
  throw new Error("usage: droid-e2e-sender <target> <nonce> <expected-reply> with AGENT_PEERS_PORT and AGENT_PEERS_SECRET_PATH");
}
const secret = readSharedSecret(secretPath);
if (!secret) throw new Error("shared secret is unavailable");
const client = createClient(`http://127.0.0.1:${port}`, secret);
const senderName = `droid-e2e-sender-${process.pid}`;
const registered = await client.register({
  peer_type: "claude",
  name: senderName,
  pid: process.pid,
  cwd: process.cwd(),
  git_root: process.cwd(),
  tty: null,
  summary: "manual live Droid wake verifier",
});

try {
  const sent = await client.sendMessage({
    from_id: registered.id,
    session_token: registered.session_token,
    to_id_or_name: target,
    text: `${nonce}: Reply to ${senderName} with exactly ${expectedReply} using send_message.`,
  });
  if (!sent.ok) throw new Error(sent.error ?? "send failed");
  console.log(`sent: ${sent.message_id}`);

  const deadline = Date.now() + 120_000;
  let verified = false;
  while (Date.now() < deadline) {
    await client.heartbeat({ id: registered.id, session_token: registered.session_token });
    const messages = await client.pollMessages({ id: registered.id, session_token: registered.session_token });
    const reply = messages.find((message) => message.text.trim() === expectedReply);
    if (reply) {
      const ack = await client.ackMessages({
        id: registered.id,
        session_token: registered.session_token,
        lease_tokens: [reply.lease_token],
      });
      console.log(`reply: ${reply.text}`);
      console.log(`from: ${reply.from_name}`);
      console.log(`acked: ${ack.acked}`);
      verified = true;
      break;
    }
    await Bun.sleep(500);
  }
  if (!verified) throw new Error("timed out waiting for Droid reply");
} finally {
  await client.unregister({ id: registered.id, session_token: registered.session_token }).catch(() => {});
}
