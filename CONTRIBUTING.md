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
| Runtime | Node.js | 18+ |
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
│   ├── relay_bridge.js     # Off-LAN access through a relay
│   ├── fs_ops.js           # Home-scoped file browse/read/write
│   ├── plugins/            # Plugin system
│   │   ├── logger.js       # Event logging
│   │   ├── metrics.js      # Session metrics
│   │   └── auth.js         # Token authentication
│   ├── channels/           # Notification channels
│   │   ├── telegram.js
│   │   ├── discord.js
│   │   └── email.js
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
# Run all tests
node --test daemon/src/__tests__/*.test.js

# Run specific test
node --test daemon/src/__tests__/plugins.test.js

# Watch mode (Node 20+)
node --test --watch daemon/src/__tests__/*.test.js
```

### Security Considerations

- Never log sensitive data (tokens, passwords)
- Validate all WebSocket messages
- Rate limit proposal approvals
- Plugin isolation: plugins cannot access other plugins' state

## Pull Request Checklist

- [ ] Tests pass (`node --test daemon/src/__tests__/*.test.js`)
- [ ] No console.log in production code (use logger)
- [ ] WebSocket messages validated
- [ ] Plugin hooks documented
- [ ] README updated if new feature

## Commit Messages

```
feat: add Discord notification channel
fix: handle WebSocket disconnection gracefully
plugin: add session metrics collector
docs: update plugin development guide
test: add proposal manager tests
```
