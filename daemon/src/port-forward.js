import net from "node:net";

const forwards = new Map();

export function start({ id, localPort, remoteHost, remotePort }) {
  const server = net.createServer((clientSock) => {
    const remote = net.createConnection({ host: remoteHost, port: remotePort });
    clientSock.pipe(remote);
    remote.pipe(clientSock);
    remote.on("error", () => clientSock.destroy());
    clientSock.on("error", () => remote.destroy());
    clientSock.on("close", () => remote.destroy());
    remote.on("close", () => clientSock.destroy());
  });

  server.on("error", (e) => {
    const f = forwards.get(id);
    if (f) { f.error = e.message; f.state = "error"; }
  });

  server.listen(localPort, "127.0.0.1", () => {
    const f = forwards.get(id);
    if (f) f.state = "active";
  });

  forwards.set(id, {
    id,
    localPort,
    remoteHost,
    remotePort,
    state: "starting",
    server,
    error: null,
    created: Date.now(),
  });

  return { id, localPort, remoteHost, remotePort };
}

export function stop(id) {
  const f = forwards.get(id);
  if (!f) return false;
  f.server.close();
  forwards.delete(id);
  return true;
}

export function list() {
  return [...forwards.values()].map((f) => ({
    id: f.id,
    localPort: f.localPort,
    remoteHost: f.remoteHost,
    remotePort: f.remotePort,
    state: f.state,
    error: f.error,
  }));
}
