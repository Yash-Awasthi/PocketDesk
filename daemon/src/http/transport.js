import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** TLS is on only when both files are there; a half-configured cert falls back to plaintext. */
export function tlsEnabled(tls) {
  return Boolean(tls?.enabled && fs.existsSync(tls.cert) && fs.existsSync(tls.key));
}

/**
 * No page here may be framed or content-sniffed; the pair page also carries a secret.
 * /access changes local settings, so it alone may POST; everything else is read-only GET.
 * Returns false when the 405 was already sent.
 */
export function guardRequest(req, res) {
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("content-security-policy", "frame-ancestors 'none'");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  if (req.method !== "GET" && !(req.method === "POST" && req.url.startsWith("/access"))) {
    res.writeHead(405).end();
    return false;
  }
  return true;
}

/**
 * This machine's own browser: a loopback peer and a loopback Host. DNS rebinding delivers a web
 * page's requests from 127.0.0.1 under its own name, so the Host header must match too.
 */
export function isLoopback(req) {
  const socket = /** @type {any} */ (req.socket);
  // Windows dual-stack sockets present IPv4 clients as ::ffff:127.0.0.1.
  const remoteAddr = (socket.remoteAddress || "").replace(/^::ffff:/, "");
  return (
    !socket._usb &&
    (remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "[::1]") &&
    LOOPBACK_HOST.test(req.headers.host || "")
  );
}

/**
 * The three listeners the daemon answers on: the phone port, the PC browser's plain-HTTP port and
 * the USB port. Without TLS the main port binds to loopback, so plaintext never reaches the LAN.
 */
export function createTransport({ tls, tlsOn, port, handler, onUpgrade }) {
  const secure = tlsOn ? { cert: fs.readFileSync(tls.cert), key: fs.readFileSync(tls.key) } : null;
  const server = secure ? https.createServer(secure, handler) : http.createServer(handler);
  // Plaintext would put the token and every byte on the LAN in the clear, so without TLS only this machine may connect.
  if (!secure)
    server.on("connection", (s) => {
      if (!/^(::ffff:)?127\.|^::1$/.test(s.remoteAddress || "")) s.destroy();
    });
  server.on("upgrade", onUpgrade);

  // The PC's own browser: plain HTTP bound to loopback, which browsers treat as a secure context, so the
  // phone page opens without a certificate warning while phones keep the pinned TLS port.
  const localPort = Number(process.env.RH_LOCAL_PORT) || port + 10;
  const local = secure ? http.createServer(handler) : null;
  local?.on("upgrade", onUpgrade);
  local?.on("error", (e) => console.warn(`  local page unavailable on ${localPort}: ${e.message}`));
  local?.listen(localPort, "127.0.0.1");

  // A phone on a USB cable, through adb reverse: it arrives from 127.0.0.1 but is not this PC, so
  // its own port marks every socket and nothing loopback-only is granted to it.
  const usbPort = Number(process.env.RH_USB_PORT) || port + 30;
  const usb = secure ? https.createServer(secure, handler) : null;
  const markUsb = (s) => {
    const sock = /** @type {any} */ (s);
    sock._usb = true;
  };
  usb?.on("connection", markUsb);
  usb?.on("secureConnection", markUsb);
  usb?.on("upgrade", onUpgrade);
  usb?.on("error", (e) => console.warn(`  USB link unavailable on ${usbPort}: ${e.message}`));
  usb?.listen(usbPort, "127.0.0.1");

  return {
    server,
    usbPort,
    /** Bind the main port: a plaintext daemon answers this machine only. */
    listen(cb) {
      server.listen(port, secure ? undefined : "127.0.0.1", cb);
    },
  };
}
