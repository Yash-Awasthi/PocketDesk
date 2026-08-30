/**
 * SSH Protocol Engine with State Machine
 * Extracted from: cbssh (ConnectBot SSH library)
 * Patterns: SSH protocol state machine, channel management, SFTP operations,
 *           port forwarding, algorithm negotiation, pluggable transport
 */

const EventEmitter = require('events');

// ─── SSH Protocol States ───────────────────────────────────────────────

const SSHState = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  BANNER_EXCHANGE: 'banner_exchange',
  KEY_EXCHANGE: 'key_exchange',
  KEY_EXCHANGE_DONE: 'key_exchange_done',
  SERVER_AUTH: 'server_auth',
  USER_AUTH: 'user_auth',
  SERVICE_REQUEST: 'service_request',
  CHANNEL_OPEN: 'channel_open',
  CONNECTED: 'connected',
  DISCONNECTING: 'disconnecting',
  ERROR: 'error',
};

// ─── Algorithm Suites ──────────────────────────────────────────────────

const DEFAULT_ALGORITHMS = {
  kex: [
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp521',
    'diffie-hellman-group-exchange-sha256',
    'diffie-hellman-group14-sha256',
  ],
  hostKey: [
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
    'rsa-sha2-512',
    'rsa-sha2-256',
  ],
  cipher: [
    'chacha20-poly1305@openssh.com',
    'aes256-gcm@openssh.com',
    'aes128-gcm@openssh.com',
    'aes256-ctr',
    'aes192-ctr',
    'aes128-ctr',
  ],
  mac: [
    'hmac-sha2-256-etm@openssh.com',
    'hmac-sha2-512-etm@openssh.com',
    'hmac-sha2-256',
    'hmac-sha2-512',
  ],
  compression: ['none', 'zlib@openssh.com'],
};

// ─── Channel Types ─────────────────────────────────────────────────────

const ChannelType = {
  SESSION: 'session',
  DIRECT_TCPIP: 'direct-tcpip',
  FORWARDING_TCPIP: 'forwarded-tcpip',
  AGENT: 'auth-agent@openssh.com',
};

// ─── SSH Session ───────────────────────────────────────────────────────

class SSHSession extends EventEmitter {
  constructor(config = {}) {
    super();
    this.state = SSHState.DISCONNECTED;
    this.host = config.host;
    this.port = config.port || 22;
    this.username = config.username;
    this.authMethod = config.authMethod || 'password';
    this.algorithms = { ...DEFAULT_ALGORITHMS, ...config.algorithms };
    this.channels = new Map();
    this.channelIdCounter = 0;
    this.kexState = null;
    this.sessionId = null;
    this.serverHostKey = null;
    this.transport = config.transport || null;
    this.keepaliveInterval = config.keepaliveInterval || 30000;
    this._keepaliveTimer = null;
  }

  /**
   * Connect to SSH server and perform handshake
   */
  async connect() {
    this.state = SSHState.CONNECTING;
    this.emit('state', this.state);

    try {
      // Banner exchange
      this.state = SSHState.BANNER_EXCHANGE;
      this.emit('state', this.state);

      // Key exchange
      this.state = SSHState.KEY_EXCHANGE;
      this.emit('state', this.state);

      // Negotiate algorithms
      const negotiated = this._negotiateAlgorithms();
      this.emit('algorithms:negotiated', negotiated);

      this.state = SSHState.KEY_EXCHANGE_DONE;
      this.emit('state', this.state);

      // Server authentication
      this.state = SSHState.SERVER_AUTH;
      this.emit('state', this.state);

      // User authentication
      this.state = SSHState.USER_AUTH;
      this.emit('state', this.state);

      // Service request
      this.state = SSHState.SERVICE_REQUEST;
      this.emit('state', this.state);

      this.state = SSHState.CONNECTED;
      this.emit('state', this.state);
      this.emit('connected');

      this._startKeepalive();
    } catch (error) {
      this.state = SSHState.ERROR;
      this.emit('state', this.state);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Open a shell channel
   */
  async openShell(options = {}) {
    if (this.state !== SSHState.CONNECTED) {
      throw new Error('Not connected');
    }

    const channelId = this.channelIdCounter++;
    const channel = {
      id: channelId,
      type: ChannelType.SESSION,
      state: 'open',
      pty: options.pty !== false,
      term: options.term || 'xterm-256color',
      width: options.width || 80,
      height: options.height || 24,
      env: options.env || {},
      stdin: [],
      stdout: [],
      stderr: [],
    };

    this.channels.set(channelId, channel);
    this.emit('channel:open', channel);
    return channel;
  }

  /**
   * Execute a command in a channel
   */
  async execute(channelId, command) {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    this.emit('channel:exec', { channelId, command });
    return { channelId, command, status: 'executing' };
  }

  /**
   * Start SFTP subsystem
   */
  async startSFTP(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    channel.sftp = {
      requests: new Map(),
      requestIdCounter: 0,
    };

    this.emit('sftp:started', { channelId });
    return channel.sftp;
  }

  /**
   * SFTP operations
   */
  async sftpListDir(channelId, path) {
    this.emit('sftp:readdir', { channelId, path });
    return { path, files: [] };
  }

  async sftpReadFile(channelId, path) {
    this.emit('sftp:read', { channelId, path });
    return { path, data: Buffer.alloc(0) };
  }

  async sftpWriteFile(channelId, path, data) {
    this.emit('sftp:write', { channelId, path, size: data.length });
    return { path, written: data.length };
  }

  async sftpStat(channelId, path) {
    this.emit('sftp:stat', { channelId, path });
    return { path, isDir: false, size: 0, mtime: 0 };
  }

  /**
   * Set up local port forwarding
   */
  async forwardLocal(localHost, localPort, remoteHost, remotePort) {
    const forwardId = `local:${localHost}:${localPort}->${remoteHost}:${remotePort}`;
    const forward = {
      id: forwardId,
      type: 'local',
      localHost,
      localPort,
      remoteHost,
      remotePort,
      active: true,
    };

    this.emit('forward:local', forward);
    return forward;
  }

  /**
   * Set up remote port forwarding
   */
  async forwardRemote(bindHost, bindPort, remoteHost, remotePort) {
    const forwardId = `remote:${bindHost}:${bindPort}->${remoteHost}:${remotePort}`;
    const forward = {
      id: forwardId,
      type: 'remote',
      bindHost,
      bindPort,
      remoteHost,
      remotePort,
      active: true,
    };

    this.emit('forward:remote', forward);
    return forward;
  }

  /**
   * Set up dynamic SOCKS5 proxy
   */
  async forwardDynamic(bindHost, bindPort) {
    const forward = {
      id: `dynamic:${bindHost}:${bindPort}`,
      type: 'dynamic',
      bindHost,
      bindPort,
      active: true,
    };

    this.emit('forward:dynamic', forward);
    return forward;
  }

  /**
   * Forward SSH agent
   */
  async forwardAgent(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    channel.agentForwarding = true;
    this.emit('agent:forwarded', { channelId });
    return { channelId, agentForwarding: true };
  }

  _negotiateAlgorithms() {
    const negotiated = {};
    for (const [category, supported] of Object.entries(this.algorithms)) {
      negotiated[category] = supported[0]; // Pick first (preferred) for now
    }
    return negotiated;
  }

  _startKeepalive() {
    if (this.keepaliveInterval > 0) {
      this._keepaliveTimer = setInterval(() => {
        if (this.state === SSHState.CONNECTED) {
          this.emit('keepalive');
        }
      }, this.keepaliveInterval);
    }
  }

  /**
   * Disconnect gracefully
   */
  async disconnect() {
    this.state = SSHState.DISCONNECTING;
    this.emit('state', this.state);

    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
    }

    for (const [id, channel] of this.channels) {
      channel.state = 'closed';
      this.emit('channel:close', { channelId: id });
    }
    this.channels.clear();

    this.state = SSHState.DISCONNECTED;
    this.emit('state', this.state);
    this.emit('disconnected');
  }

  getStatus() {
    return {
      state: this.state,
      host: this.host,
      port: this.port,
      username: this.username,
      channels: this.channels.size,
      uptime: this._startTime ? Date.now() - this._startTime : 0,
    };
  }
}

module.exports = { SSHSession, SSHState, ChannelType, DEFAULT_ALGORITHMS };
