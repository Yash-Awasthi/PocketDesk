# Contributing to PocketDesk

Remote terminal access daemon with WebSocket, plugins, and notifications.

## Quick Start

```bash
# Clone and setup
git clone https://github.com/Yash-Awasthi/claude-code-hermit.git
cd PocketDesk
npm install

# Run tests
cd daemon && npm test

# Start daemon
node daemon/src/index.js
```

## Tech Stack

| Component | Technology | Version |
|-----------|------------|---------|
| Language | JavaScript | ES2022+ |
| Runtime | Node.js | 24+ |
| Protocol | WebSocket | ws 8.0+ |
| Terminal | xterm.js | 5.0+ |
| Testing | Node.js test runner | Built-in |

## Project Structure

```
daemon/
├── src/
│   ├── index.js            # Entry point
│   ├── server.js           # HTTP/WebSocket server, auth, message dispatch
│   ├── handlers/           # Message handlers grouped by area
│   ├── iroh_link.js        # Off-LAN access over iroh
│   ├── fs_ops.js           # Home-scoped file browse/read/write
│   ├── plugins/            # Plugin system
│   │   ├── logger.js       # Event logging
│   │   ├── metrics.js      # Session metrics
│   │   └── auth.js         # Token authentication
public/
├── index.html              # Web UI
├── xterm/                  # Terminal frontend
└── css/                    # Styles
```

## Development Guidelines

### Plugin Development

Plugins are the primary extension mechanism:

```javascript
// daemon/src/plugins/my-plugin.js
module.exports = {
  name: 'my-plugin',
  version: '1.0.0',
  hooks: ['onMessage', 'onConnect'],

  init(ctx) {
    this.logger = ctx.logger;
    this.config = ctx.config;
  },

  onConnect(session) {
    this.logger.info(`Session connected: ${session.id}`);
  },

  onMessage(session, message) {
    if (message.type === 'chat') {
      this.logger.info(`Chat: ${message.data}`);
    }
  },

  onDisconnect(session) {
    this.logger.info(`Session ended: ${session.id}`);
  },
};
```

### Notification Channels

```javascript
// daemon/src/channels/my-channel.js
class MyChannel {
  constructor(config) {
    this.config = config;
  }

  async send(message) {
    // Send notification
    console.log(`[${this.config.name}] ${message}`);
  }

  async sendAlert(severity, title, body) {
    // Send alert with severity level
  }
}

module.exports = MyChannel;
```

### WebSocket Messages

```javascript
// Message format
{
  type: 'chat' | 'proposal' | 'terminal' | 'heartbeat',
  data: { ... },
  timestamp: Date.now()
}

// Proposal lifecycle
{
  type: 'proposal_created',
  data: {
    id: 'uuid',
    action: 'file_write',
    target: '/path/to/file',
    status: 'pending'
  }
}
```

### Code Style

```javascript
// Use ES2022+ features
// - async/await
// - Optional chaining (?.)
// - Nullish coalescing (??)
// - Destructuring

// Good
async function handleMessage(session, message) {
  const { type, data } = message;
  if (type !== 'chat') return;
  
  const { content, author } = data ?? {};
  if (!content) return;
  
  await broadcast({ type: 'chat', data: { content, author } });
}

// Bad
function handleMessage(session, message) {
  if (message.type == 'chat') {
    if (message.data && message.data.content) {
      broadcast({ type: 'chat', data: message.data });
    }
  }
}
```

### Testing

```bash
# Run all tests (from daemon/)
npm test

# Run specific test
node --test test/plugins.test.mjs

# Watch mode
node --test --watch "test/*.test.mjs"
```

### Security Considerations

- Never log sensitive data (tokens, passwords)
- Validate all WebSocket messages
- Rate limit proposal approvals
- Plugin isolation: plugins cannot access other plugins' state

## Pull Request Checklist
- [ ] Tests pass (`cd daemon && npm test`)
- [ ] No console.log in production code (use logger)
- [ ] WebSocket messages validated
- [ ] Plugin hooks documented
- [ ] README updated if new feature
- [ ] No detection-evasion code (see [docs/INTEGRITY.md](docs/INTEGRITY.md)): the daemon
      stays visible to process/task/port enumeration and usable with a machine policy
      kill switch

### No detection evasion, ever

PocketDesk stays visible to the machine it runs on: no process hiding, no kernel
or user-mode driver, no anti-forensics, no workaround aimed at an antivirus, EDR
or anti-cheat product. The rule, the threat model behind it and the cases we
refuse are in [docs/INTEGRITY.md](docs/INTEGRITY.md) (P4). Two checks keep it
true; the first runs in `npm test`, the second is a copy-paste gate:

```bash
cd daemon && node --test test/no-evasion.test.mjs

grep -rniE 'invisible to anti-?cheat|invisible to antivirus|RAT heuristics|\bAMS[A-Z]?\b|undetectab|hide from (task manager|enumeration)|evade (detection|antivirus|anti-?cheat)' \
  --include='*.md' --include='*.js' --include='*.mjs' --include='*.cs' --include='*.ps1' --include='*.kt' \
  . | grep -v node_modules | grep -v '^./plan.md' | grep -v '^./docs/INTEGRITY.md' | grep -v '^./CONTRIBUTING.md' | grep -v '^./daemon/test/no-evasion.test.mjs'
```

Expected output: none. `plan.md`, `docs/INTEGRITY.md` and this file are exempt
because naming the forbidden pattern is their job — everywhere else a match is a
bug.

## Commit Messages
```
feat: add Discord notification channel
fix: handle WebSocket disconnection gracefully
plugin: add session metrics collector
docs: update plugin development guide
test: add proposal manager tests
```
