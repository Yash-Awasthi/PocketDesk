# Plugins

The daemon loads plugins from `daemon/src/plugins/*.js`. Each file default-exports a manifest;
a manifest that fails validation is skipped with a `plugin skip:` line, and a file that throws on
import logs `plugin error:` and loads nothing.

```js
export default {
  name: "my-plugin", // required, string
  version: "1.0.0", // required, string
  hooks: ["init", "onMessage"], // optional, must name real hooks
  init(ctx) {
    this._tag = ctx.config?.tag || "tag";
  },
  onMessage(ctx, ws, msg) {
    if (msg.type !== "chatmsg") return undefined;
    return { modify: { ...msg, text: `[${this._tag}] ${msg.text}` } };
  },
};
```

## Lifecycle

Hooks run in this order:

1. `discover` imports each file and registers it (validation plus hook wiring).
2. `init` — in registration order, before the daemon accepts connections.
3. `start` — in registration order, after the daemon is listening.
4. Event hooks (`onConnect`, `onMessage`, `onChatMessage`, …) — for the daemon's lifetime.
5. `stop` — in registration order, deliberately **not** reversed.

Every hook is invoked as `fn.call(manifest, ctx, ...args)`, so `this` is the manifest object and a
plugin can keep per-instance state on it (`this._tag` above). The hook signature for messages is
`(ctx, ws, msg)`; `init`, `start` and `stop` receive only `ctx`.

## Context

`ctx` is the object handed to `createPluginManager` from `src/server.js`:

| Field       | Meaning                                         |
| ----------- | ----------------------------------------------- |
| `sessions`  | session manager                                 |
| `chat`      | chat manager                                    |
| `registry`  | connected-computer registry                     |
| `proposals` | pending proposals                               |
| `broadcast` | send a message to every subscribed socket       |
| `config`    | `{ port, token, dataDir }`, plus any extra keys |

## Return values

| Return            | Effect                                                                |
| ----------------- | --------------------------------------------------------------------- |
| `undefined`       | continue; the payload stays as it is                                  |
| `{ block: true }` | stop delivery; no later plugin or handler sees the event              |
| `{ modify: p }`   | replace the event payload (the second hook argument) for what follows |

`callHook` reports the end state as `{ blocked, msg }`; `msg` is the last payload after all
modifications, or `null` when a plugin blocked.

## Testing with the harness

`createTestHarness` builds a manager around a mock context — no running daemon, no files.
Plugins are registered through the same `register` path as discovery, so validation is exercised
too. Each `init`/`start`/`stop`/`call` is appended to `events` as `{ hook, args }` in call order.

```js
import { createTestHarness } from "../src/plugins.js";
import chatTag from "../examples/plugins/chat-tag/plugin.js";

const h = createTestHarness(chatTag, { config: { tag: "#desk" } });
await h.init();
const { blocked, msg } = await h.call("onMessage", {}, { type: "chatmsg", text: "hello" });
// blocked === false, msg.text === "#desk hello"
console.log(
  h.events.map((e) => e.hook),
  h.list(),
);
```

`ctx` overrides are shallow except `config`, which merges over the defaults
(`{ port: 8765, token: "test-token", dataDir: ".pocketdesk-test" }`).

## Examples are not auto-loaded

`daemon/examples/plugins/chat-tag/plugin.js` is a complete working plugin, but discovery scans
only `daemon/src/plugins/*.js`. Copy an example there, or drive it through the harness, to use it.
