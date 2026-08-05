const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const app = express();
app.use(cors());

// Serve client build from ../dist. If missing, attempt to build the client automatically.
const CLIENT_DIST = path.join(__dirname, '..', 'dist');
try {
  if (!fs.existsSync(CLIENT_DIST)) {
    console.log('\nClient build not found at ../dist. Running client build...');
    // Run the root build script. This requires dependencies to be installed in the project root.
    execSync('npm run build', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
    console.log('Client build finished.');
  }
  if (fs.existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST));
    app.get('*', (req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
  }
} catch (err) {
  console.error('Error while preparing client build:', err);
}
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ─── Game Constants ──────────────────────────────────────────────────────────

const MAIN_PATH = [
  [6,1],[6,2],[6,3],[6,4],[6,5],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],
  [0,7],[0,8],[1,8],[2,8],[3,8],[4,8],[5,8],[6,9],[6,10],[6,11],[6,12],[6,13],[6,14],
  [7,14],[8,14],[8,13],[8,12],[8,11],[8,10],[8,9],[9,8],[10,8],[11,8],[12,8],[13,8],[14,8],
  [14,7],[14,6],[13,6],[12,6],[11,6],[10,6],[9,6],[8,5],[8,4],[8,3],[8,2],[8,1],[8,0],
  [7,0],[6,0],
];

const HOME_STRETCHES = {
  green: [[7,1],[7,2],[7,3],[7,4],[7,5],[7,6]],
  yellow: [[1,7],[2,7],[3,7],[4,7],[5,7],[6,7]],
  red: [[7,13],[7,12],[7,11],[7,10],[7,9],[7,8]],
  blue: [[13,7],[12,7],[11,7],[10,7],[9,7],[8,7]],
};

const START_INDICES = { green: 0, yellow: 13, red: 26, blue: 39 };
const SAFE_POSITIONS = [0, 8, 13, 21, 26, 34, 39, 47];

// ─── Game Logic Functions ────────────────────────────────────────────────────

function isSafePosition(idx) { return SAFE_POSITIONS.includes(idx); }

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function getCurrentPlayer(state) { return state.players[state.currentPlayerIndex]; }

function getValidMoves(tokens, player, diceValue) {
  return tokens.filter(t => t.player === player).filter(token => {
    if (token.steps === -1) return diceValue === 6;
    if (token.steps >= 56) return false;
    return token.steps + diceValue <= 56;
  });
}

function getValidMovesForAnyDice(tokens, player, pendingDice) {
  const seen = new Set();
  const result = [];
  for (const dv of pendingDice) {
    for (const t of getValidMoves(tokens, player, dv)) {
      const key = `${t.player}-${t.id}`;
      if (!seen.has(key)) { seen.add(key); result.push(t); }
    }
  }
  return result;
}

function executeMove(tokens, token, diceValue) {
  const newTokens = tokens.map(t => ({ ...t }));
  const mt = newTokens.find(t => t.id === token.id && t.player === token.player);
  let captured = false, enteredBoard = false;

  if (mt.steps === -1) { mt.steps = 0; enteredBoard = true; }
  else { mt.steps += diceValue; }

  if (mt.steps >= 0 && mt.steps <= 50) {
    const pi = (START_INDICES[mt.player] + mt.steps) % 52;
    if (!isSafePosition(pi)) {
      newTokens.forEach(t => {
        if (t.player !== mt.player && t.steps >= 0 && t.steps <= 50) {
          if ((START_INDICES[t.player] + t.steps) % 52 === pi) { t.steps = -1; captured = true; }
        }
      });
    }
  }
  return { tokens: newTokens, captured, enteredBoard };
}

function checkWin(tokens, player) { return tokens.filter(t => t.player === player).every(t => t.steps >= 56); }

function shouldGetExtraTurnFromDice(options, diceValues) {
  if (options.diceCount === 1) return diceValues[0] === 6;
  return diceValues.length === 2 && diceValues[0] === 6 && diceValues[1] === 6;
}

function shouldReverseTurn(options, consecutiveSixes) {
  return options.diceCount === 1 ? consecutiveSixes >= 3 : consecutiveSixes >= 2;
}

function rollHasSix(dv) { return dv.some(v => v === 6); }
function isDoubleSix(dv) { return dv.length === 2 && dv[0] === 6 && dv[1] === 6; }

function createInitialState(players, options) {
  const tokens = [];
  players.forEach(player => {
    for (let i = 0; i < 4; i++) tokens.push({ id: i, player, steps: -1 });
  });
  return {
    players, currentPlayerIndex: 0, tokens, diceValues: [], pendingDice: [],
    selectedDiceIndex: null, diceRolled: false, winner: null, gameStarted: true,
    message: `${capitalize(players[0])}'s turn - Roll the dice!`, options,
    earnedExtraTurn: false, isTransitioning: false,
    turnSnapshot: tokens.map(t => ({ ...t })),
    consecutiveSixes: 0, rollHasSix: false,
  };
}

// ─── Server State ────────────────────────────────────────────────────────────

const users = new Map();   // socketId -> { username, roomId }
const rooms = new Map();   // roomId -> room object

function generateRoomId() {
  let id;
  do { id = Math.random().toString(36).substring(2, 8).toUpperCase(); } while (rooms.has(id));
  return id;
}

function broadcastOnlineUsers() {
  const list = [];
  for (const [, u] of users) { if (!u.roomId) list.push(u.username); }
  io.emit('online-users', { users: list });
}

function getRoomInfo(room) {
  return {
    id: room.id, host: room.host, players: room.players,
    playerColors: room.playerColors, options: room.options,
    started: room.started, playerCount: room.playerCount,
  };
}

function findSocketByUsername(username) {
  for (const [sid, u] of users) { if (u.username === username) return sid; }
  return null;
}

// ─── Process Roll (Server-side) ──────────────────────────────────────────────

function processRoll(room, diceValues) {
  const state = room.gameState;
  const player = getCurrentPlayer(state);
  const hasSix = rollHasSix(diceValues);
  const isDouble = isDoubleSix(diceValues);

  let newConsecutiveSixes = state.consecutiveSixes;
  if (state.options.diceCount === 1) {
    newConsecutiveSixes = diceValues[0] === 6 ? newConsecutiveSixes + 1 : 0;
  } else {
    newConsecutiveSixes = isDouble ? newConsecutiveSixes + 1 : 0;
  }

  if (shouldReverseTurn(state.options, newConsecutiveSixes)) {
    const restored = state.turnSnapshot.map(t => ({ ...t }));
    const npi = (state.currentPlayerIndex + 1) % state.players.length;
    Object.assign(state, {
      tokens: restored, diceRolled: false, diceValues: [], pendingDice: [],
      selectedDiceIndex: null, currentPlayerIndex: npi, earnedExtraTurn: false,
      consecutiveSixes: 0, rollHasSix: false, turnSnapshot: restored.map(t => ({ ...t })),
      message: state.options.diceCount === 1
        ? `⚠️ 3 consecutive 6s! ${capitalize(player)}'s turn is reversed!`
        : `⚠️ 2 consecutive double 6s! ${capitalize(player)}'s turn is reversed!`,
    });
    return;
  }

  const pendingDice = state.options.diceCount === 1 ? [diceValues[0]] : [...diceValues];
  const anyValid = getValidMovesForAnyDice(state.tokens, player, pendingDice);
  const hasValidMoves = anyValid.length > 0;
  const extraFromDice = shouldGetExtraTurnFromDice(state.options, diceValues);

  let message = state.options.diceCount === 1
    ? `${capitalize(player)} rolled a ${diceValues[0]}!`
    : `${capitalize(player)} rolled ${diceValues[0]} & ${diceValues[1]}!`;
  if (!hasValidMoves) message += ' No valid moves.';
  else if (pendingDice.length === 1) message += ' Tap a token to move.';
  else message += ' Select a die, then tap a token.';

  Object.assign(state, {
    diceValues, pendingDice, selectedDiceIndex: pendingDice.length === 1 ? 0 : null,
    diceRolled: true, earnedExtraTurn: extraFromDice, consecutiveSixes: newConsecutiveSixes,
    rollHasSix: hasSix, message,
  });

  if (!hasValidMoves) {
    if (extraFromDice) {
      Object.assign(state, {
        diceRolled: false, diceValues: [], pendingDice: [], selectedDiceIndex: null,
        earnedExtraTurn: false,
        message: `${capitalize(player)} gets another turn! (${state.options.diceCount === 1 ? 'rolled 6' : 'double 6'})`,
      });
    } else {
      const npi = (state.currentPlayerIndex + 1) % state.players.length;
      Object.assign(state, {
        diceRolled: false, diceValues: [], pendingDice: [], selectedDiceIndex: null,
        currentPlayerIndex: npi, consecutiveSixes: 0, rollHasSix: false,
        turnSnapshot: state.tokens.map(t => ({ ...t })),
        message: `${capitalize(state.players[npi])}'s turn - Roll the dice!`,
      });
    }
  }
}

// ─── Process Move (Server-side) ──────────────────────────────────────────────

function processMove(room, token) {
  const state = room.gameState;
  const cp = getCurrentPlayer(state);

  let diceValue, diceIndex;
  if (state.selectedDiceIndex !== null) {
    diceIndex = state.selectedDiceIndex;
    diceValue = state.pendingDice[diceIndex];
  } else {
    const idx = state.pendingDice.findIndex(dv => {
      return getValidMoves(state.tokens, cp, dv).some(t => t.id === token.id && t.player === token.player);
    });
    if (idx === -1) return;
    diceIndex = idx; diceValue = state.pendingDice[idx];
  }

  if (!getValidMoves(state.tokens, cp, diceValue).some(t => t.id === token.id && t.player === token.player)) return;

  const { tokens: newTokens, captured, enteredBoard } = executeMove(state.tokens, token, diceValue);
  const winner = checkWin(newTokens, cp) ? cp : null;
  const extraFromDice = state.earnedExtraTurn;
  const extraFromCapture = captured && state.options.extraTurnOnCapture;
  const extraFromEntry = enteredBoard && state.options.extraRollOnEntry;
  const anyExtraTurn = extraFromDice || extraFromCapture || extraFromEntry;

  const newPendingDice = [...state.pendingDice];
  newPendingDice.splice(diceIndex, 1);

  const isChooseMode = state.options.diceCount === 2 && state.options.twoDiceMode === 'choose';
  if (isChooseMode && !state.rollHasSix && newPendingDice.length > 0) newPendingDice.length = 0;

  if (newPendingDice.length > 0) {
    if (getValidMovesForAnyDice(newTokens, cp, newPendingDice).length === 0) newPendingDice.length = 0;
  }

  state.tokens = newTokens;

  if (newPendingDice.length === 0) {
    if (winner) {
      Object.assign(state, { pendingDice: [], selectedDiceIndex: null, diceRolled: false, diceValues: [], winner,
        message: `🎉 ${capitalize(winner)} wins the game! 🎉` });
      return;
    }
    if (anyExtraTurn) {
      const reasons = [];
      if (extraFromDice) reasons.push(state.options.diceCount === 1 ? 'rolled 6' : 'double 6');
      if (extraFromCapture) reasons.push('captured');
      if (extraFromEntry) reasons.push('entered board');
      Object.assign(state, { pendingDice: [], selectedDiceIndex: null, diceValues: [], diceRolled: false,
        earnedExtraTurn: false, message: `${capitalize(cp)} gets another turn! (${reasons.join(' & ')})` });
      return;
    }
    const npi = (state.currentPlayerIndex + 1) % state.players.length;
    Object.assign(state, { pendingDice: [], selectedDiceIndex: null, diceValues: [], diceRolled: false,
      currentPlayerIndex: npi, earnedExtraTurn: false, consecutiveSixes: 0, rollHasSix: false,
      turnSnapshot: state.tokens.map(t => ({ ...t })),
      message: `${capitalize(state.players[npi])}'s turn - Roll the dice!` });
  } else {
    Object.assign(state, { pendingDice: newPendingDice,
      selectedDiceIndex: newPendingDice.length === 1 ? 0 : null, earnedExtraTurn: anyExtraTurn,
      message: newPendingDice.length === 1 ? `Tap a token to move ${newPendingDice[0]} steps.` : 'Select a die, then tap a token.' });
  }
}

// ─── Socket.io Connection ────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('login', (username) => {
    if (!username || username.trim().length < 2) {
      return socket.emit('login-error', 'Username must be at least 2 characters');
    }
    const uname = username.trim();
    for (const [, u] of users) {
      if (u.username === uname) return socket.emit('login-error', 'Username already taken');
    }
    users.set(socket.id, { username: uname, roomId: null });
    socket.emit('login-success', { username: uname });
    broadcastOnlineUsers();
    console.log(`User logged in: ${uname}`);
  });

  socket.on('create-room', ({ playerCount, options }) => {
    const user = users.get(socket.id);
    if (!user) return;
    const roomId = generateRoomId();
    const colors = ['green', 'yellow', 'red', 'blue'];
    rooms.set(roomId, {
      id: roomId, host: user.username, players: [user.username], playerCount,
      options, playerColors: { [user.username]: 'green' }, gameState: null,
      playerSockets: { [user.username]: socket.id }, started: false,
    });
    user.roomId = roomId;
    socket.join(roomId);
    socket.emit('room-created', { roomId, room: getRoomInfo(rooms.get(roomId)) });
    broadcastOnlineUsers();
    console.log(`Room created: ${roomId} by ${user.username}`);
  });

  socket.on('invite-player', ({ roomId, username }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = users.get(socket.id);
    if (!user || room.host !== user.username) return;
    if (room.players.includes(username)) return;
    const targetSid = findSocketByUsername(username);
    if (targetSid) {
      io.to(targetSid).emit('room-invite', { roomId, from: user.username, playerCount: room.playerCount });
    }
  });

  socket.on('accept-invite', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.started) return;
    if (room.players.length >= room.playerCount) return;
    const user = users.get(socket.id);
    if (!user || room.players.includes(user.username)) return;

    room.players.push(user.username);
    room.playerSockets[user.username] = socket.id;
    user.roomId = roomId;
    socket.join(roomId);

    const colors = ['green', 'yellow', 'red', 'blue'];
    room.playerColors[user.username] = colors[room.players.length - 1];

    io.to(roomId).emit('room-updated', { roomId, room: getRoomInfo(room) });
    broadcastOnlineUsers();
    console.log(`${user.username} joined room ${roomId}`);
  });

  socket.on('reject-invite', ({ roomId }) => {
    const user = users.get(socket.id);
    if (!user) return;
    const hostSid = findSocketByUsername(rooms.get(roomId)?.host);
    if (hostSid) io.to(hostSid).emit('invite-rejected', { roomId, username: user.username });
  });

  socket.on('leave-room', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = users.get(socket.id);
    if (!user) return;

    if (room.started) return; // Can't leave during game

    room.players = room.players.filter(p => p !== user.username);
    delete room.playerColors[user.username];
    delete room.playerSockets[user.username];
    user.roomId = null;
    socket.leave(roomId);

    if (room.players.length === 0) {
      rooms.delete(roomId);
    } else {
      // Reassign host if needed
      if (room.host === user.username) room.host = room.players[0];
      // Reassign colors
      const colors = ['green', 'yellow', 'red', 'blue'];
      room.players.forEach((p, i) => { room.playerColors[p] = colors[i]; });
      io.to(roomId).emit('room-updated', { roomId, room: getRoomInfo(room) });
    }
    broadcastOnlineUsers();
  });

  socket.on('start-game', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = users.get(socket.id);
    if (!user || room.host !== user.username) return;
    if (room.players.length < room.playerCount) return;

    const playerColorList = room.players.map(p => room.playerColors[p]);
    room.gameState = createInitialState(playerColorList, room.options);
    room.started = true;

    io.to(roomId).emit('game-started', {
      roomId, gameState: room.gameState, playerColors: room.playerColors, yourColor: null,
    });
    // Send each player their color
    for (const [username, color] of Object.entries(room.playerColors)) {
      const sid = findSocketByUsername(username);
      if (sid) io.to(sid).emit('your-color', { color });
    }
    broadcastOnlineUsers();
    console.log(`Game started in room ${roomId}`);
  });

  // ─── Game Actions ───────────────────────────────────────────────────────

  socket.on('roll-dice', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameState) return;
    const user = users.get(socket.id);
    if (!user) return;

    const state = room.gameState;
    const cp = getCurrentPlayer(state);
    if (room.playerColors[user.username] !== cp) return;
    if (state.diceRolled) return;

    const diceCount = state.options.diceCount;
    const diceValues = Array.from({ length: diceCount }, () => Math.floor(Math.random() * 6) + 1);

    processRoll(room, diceValues);

    // Add rolling animation flag
    const stateToSend = { ...room.gameState, isRolling: false };
    io.to(roomId).emit('game-state', { gameState: stateToSend });
    // Send rolling animation separately
    io.to(roomId).emit('dice-rolled', { diceValues: room.gameState.diceValues });
  });

  socket.on('select-dice', ({ roomId, diceIndex }) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameState) return;
    const user = users.get(socket.id);
    if (!user) return;

    const state = room.gameState;
    if (room.playerColors[user.username] !== getCurrentPlayer(state)) return;

    room.gameState.selectedDiceIndex = diceIndex;
    io.to(roomId).emit('game-state', { gameState: room.gameState });
  });

  socket.on('move-token', ({ roomId, tokenId, player }) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameState) return;
    const user = users.get(socket.id);
    if (!user) return;

    const state = room.gameState;
    if (room.playerColors[user.username] !== getCurrentPlayer(state)) return;
    if (player !== getCurrentPlayer(state)) return;

    const token = state.tokens.find(t => t.id === tokenId && t.player === player);
    if (!token) return;

    processMove(room, token);
    io.to(roomId).emit('game-state', { gameState: room.gameState });
  });

  // ─── Disconnect ─────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (!user) return;
    console.log(`Disconnected: ${user.username}`);

    if (user.roomId) {
      const room = rooms.get(user.roomId);
      if (room) {
        io.to(user.roomId).emit('player-disconnected', { username: user.username });
      }
    }
    users.delete(socket.id);
    broadcastOnlineUsers();
  });
});

// ─── Start Server ────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🎲 Ludo Server running on port ${PORT}`);
  console.log(`   Connect clients to: http://localhost:${PORT}\n`);
});
