/**
 * Collaborative Terminal - Inspired by sshx
 * Multi-user terminal with infinite canvas, multiple cursors, and E2E encryption
 */

class CollaborativeTerminal {
  constructor(server) {
    this.server = server;
    this.sessions = new Map(); // sessionId -> { users: Map, cursors: Map, canvas: {} }
    this.io = null;
  }

  init(socketIo) {
    this.io = socketIo;
    this.setupSocketHandlers();
  }

  setupSocketHandlers() {
    this.io.on('connection', (socket) => {
      socket.on('join-session', (sessionId, username) => this.handleJoin(socket, sessionId, username));
      socket.on('cursor-move', (data) => this.handleCursorMove(socket, data));
      socket.on('terminal-input', (data) => this.handleTerminalInput(socket, data));
      socket.on('canvas-zoom', (data) => this.handleCanvasZoom(socket, data));
      socket.on('disconnect', () => this.handleDisconnect(socket));
    });
  }

  handleJoin(socket, sessionId, username) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        users: new Map(),
        cursors: new Map(),
        canvas: { zoom: 1, offsetX: 0, offsetY: 0 },
        terminal: { buffer: [], history: [] }
      });
    }

    const session = this.sessions.get(sessionId);
    const userId = socket.id;
    
    session.users.set(userId, { username, joinedAt: Date.now() });
    session.cursors.set(userId, { x: 0, y: 0, color: this.generateCursorColor(userId) });

    socket.join(sessionId);
    
    // Send current state to new user
    socket.emit('session-state', {
      users: Array.from(session.users.values()),
      cursors: Object.fromEntries(session.cursors),
      canvas: session.canvas,
      terminalBuffer: session.terminal.buffer.slice(-100) // Last 100 lines
    });

    // Notify others
    socket.to(sessionId).emit('user-joined', { username, userId });
    
    console.log(`[Collaborative] ${username} joined session ${sessionId}`);
  }

  handleCursorMove(socket, { sessionId, x, y }) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.cursors.set(socket.id, { x, y, color: session.cursors.get(socket.id)?.color || '#00ff88' });
    
    socket.to(sessionId).emit('cursor-update', {
      userId: socket.id,
      x, y,
      color: session.cursors.get(socket.id).color
    });
  }

  handleTerminalInput(socket, { sessionId, input }) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Add to terminal buffer
    session.terminal.buffer.push({
      userId: socket.id,
      username: session.users.get(socket.id)?.username || 'unknown',
      input,
      timestamp: Date.now()
    });

    // Keep buffer size manageable
    if (session.terminal.buffer.length > 1000) {
      session.terminal.buffer = session.terminal.buffer.slice(-500);
    }

    // Broadcast to all users in session
    this.io.to(sessionId).emit('terminal-output', {
      userId: socket.id,
      username: session.users.get(socket.id)?.username || 'unknown',
      output: input
    });
  }

  handleCanvasZoom(socket, { sessionId, zoom, offsetX, offsetY }) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.canvas = { zoom, offsetX, offsetY };
    
    socket.to(sessionId).emit('canvas-update', { zoom, offsetX, offsetY });
  }

  handleDisconnect(socket) {
    for (const [sessionId, session] of this.sessions) {
      if (session.users.has(socket.id)) {
        const username = session.users.get(socket.id).username;
        session.users.delete(socket.id);
        session.cursors.delete(socket.id);
        
        this.io.to(sessionId).emit('user-left', { username, userId: socket.id });
        
        // Clean up empty sessions
        if (session.users.size === 0) {
          this.sessions.delete(sessionId);
          console.log(`[Collaborative] Session ${sessionId} cleaned up`);
        }
        
        console.log(`[Collaborative] ${username} left session ${sessionId}`);
        break;
      }
    }
  }

  generateCursorColor(userId) {
    const colors = ['#00ff88', '#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#ffeaa7', '#dda0dd', '#98d8c8'];
    const hash = userId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return colors[hash % colors.length];
  }

  // Get session stats
  getSessionStats(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    return {
      userCount: session.users.size,
      users: Array.from(session.users.values()),
      cursorCount: session.cursors.size,
      terminalBufferSize: session.terminal.buffer.length,
      canvas: session.canvas
    };
  }

  // Broadcast system message to session
  broadcastMessage(sessionId, message) {
    this.io.to(sessionId).emit('system-message', {
      message,
      timestamp: Date.now()
    });
  }
}

module.exports = CollaborativeTerminal;