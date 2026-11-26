// `pocketdesk <command>` drives the running daemon over the loopback CLI port; without one, this is the daemon.
const COMMANDS = new Set([
  "list",
  "new",
  "attach",
  "send",
  "read",
  "resize",
  "kill",
  "pair",
  "record",
  "stop",
  "status",
  "doctor",
  "--status",
  "version",
  "--version",
]);
await import(COMMANDS.has(process.argv[2]) ? "./cli.js" : "./daemon.js");
