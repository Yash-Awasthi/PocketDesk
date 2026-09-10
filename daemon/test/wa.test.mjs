// WhatsApp bridge absorption test — exercises the wa_* protocol surface
// (whatsapp-claude-plugin inspiration): channel creation, QR auth lifecycle
// (disconnected → qr_pending → authenticated → ready), allowlist gating,
// command-prefix dispatch into a real terminal session, replies, history,
// stats. The e2e leg drives a real node REPL through a WhatsApp command.
import { check, connectRaw, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";

const tmp = makeTmp("rh-t-");

const PORT = 8815;
const CLI_PORT = 46815;
const TOKEN = "watoken";

async function main() {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  // Real terminal session for the e2e command leg.
  c.send({ type: "create", harness: "node", cwd: tmp, args: [] });
  const created = await c.next((m) => m.type === "created");
  const sessionId = created.id;

  // Channel with an allowlist.
  c.send({ type: "wa_create", sessionId, allowedNumbers: ["+15550001"] });
  const ch = await c.next((m) => m.type === "wa_channel");
  check("wa_create returns channel", !!ch.channel.id && ch.channel.status === "disconnected");
  const cid = ch.channel.id;

  // QR auth lifecycle.
  c.send({ type: "wa_auth_start", channelId: cid });
  const qr = await c.next((m) => m.type === "wa_qr");
  check("wa_auth_start returns QR payload", qr.ok === true && typeof qr.qr === "string" && qr.qr.length > 20);

  c.send({ type: "wa_auth_complete", channelId: cid, phoneNumber: "+15550001" });
  const auth = await c.next((m) => m.type === "wa_auth_ok");
  check("wa_auth_complete transitions to authenticated", auth.ok === true);

  c.send({ type: "wa_ready", channelId: cid });
  const ready = await c.next((m) => m.type === "wa_ready_ok");
  check("wa_ready marks channel ready", ready.ok === true);

  // Allowlisted number sends a command → dispatched into the session.
  c.send({ type: "wa_incoming", channelId: cid, from: "+15550001", messageId: "m1", body: "!40+2" });
  await c.next((m) => m.type === "wa_incoming_ok");
  const cmdEvt = await c.next((m) => m.type === "wa_event" && m.waEvent === "command_received");
  check("command event emitted", cmdEvt.command === "40+2");

  // The command was written to the real REPL; its output flows back via the
  // session output stream — verify the computed answer appears in chat via the
  // session's own subscription (out messages are base64).
  c.send({ type: "attach", id: sessionId });
  const answer = await c.next((m) => m.type === "out" && Buffer.from(m.data, "base64").toString("utf8").includes("42"), 20000).catch(() => null);
  check("WhatsApp command executed in real session", !!answer);

  // Non-allowlisted number is silently dropped.
  c.send({ type: "wa_incoming", channelId: cid, from: "+19999999", messageId: "m2", body: "!evil" });
  await c.next((m) => m.type === "wa_incoming_ok");
  c.send({ type: "wa_messages", channelId: cid });
  const hist = await c.next((m) => m.type === "wa_messages");
  check("non-allowlisted sender dropped", !hist.items.some((x) => x.from === "+19999999"));

  // Reply + history + stats.
  c.send({ type: "wa_reply", channelId: cid, to: "+15550001", body: "42 is the answer" });
  const rep = await c.next((m) => m.type === "wa_reply_ok");
  check("wa_reply acks", rep.ok === true);

  c.send({ type: "wa_stats" });
  const stats = await c.next((m) => m.type === "wa_stats");
  check("stats count channels/messages", stats.totalChannels === 1 && stats.activeChannels === 1 && stats.totalMessages >= 1);

  // Disconnect.
  c.send({ type: "wa_disconnect", channelId: cid });
  const disc = await c.next((m) => m.type === "wa_disconnected");
  check("wa_disconnect acks", disc.ok === true);
  c.send({ type: "wa_reply", channelId: cid, to: "+15550001", body: "nope" });
  const rep2 = await c.next((m) => m.type === "wa_reply_ok");
  check("replies rejected after disconnect", rep2.ok === false);

  await c.close();
  await new Promise((r) => setTimeout(r, 1200));
await teardown(tmp);

  finish();
}

main().catch((err) => { console.error("TEST ERROR:", err); process.exit(1); });
