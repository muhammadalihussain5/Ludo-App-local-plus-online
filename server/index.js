const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

const app = express();
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.get('/health', (req, res) => res.json({ ok: true }));

const CLIENT_DIST = path.join(__dirname, '..', 'dist');
try {
  if (!fs.existsSync(CLIENT_DIST)) {
    console.log('\nClient build not found at ../dist. Running client build...');
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
const io = new Server(server, { cors: { origin: allowedOrigins, methods: ['GET', 'POST'], credentials: true } });

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

function createEmptyCaptureCounts() {
  return { green: 0, yellow: 0, red: 0, blue: 0 };
}

function isSafePosition(idx) {
  return SAFE_POSITIONS.includes(idx);
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function getCurrentPlayer(state) {
  return state.players[state.currentPlayerIndex];
}

function getValidMoves(tokens, player, diceValue, captureCounts = createEmptyCaptureCounts()) {
  return tokens.filter(t => t.player === player).filter(token => {
    if (token.steps === -1) return diceValue === 6;
    if (token.steps >= 56) return false;
    if (token.steps < 51 && token.steps + diceValue > 50 && captureCounts[player] <= 0) return false;
    return token.steps + diceValue <= 56;
  });
}

function getValidMovesForAnyDice(tokens, player, pendingDice, captureCounts = createEmptyCaptureCounts()) {
  const seen = new Set();
  const result = [];
  for (const dv of pendingDice) {
    for (const t of getValidMoves(tokens, player, dv, captureCounts)) {
      const key = `${t.player}-${t.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(t);
      }
    }
  }
  return result;
}

function executeMove(tokens, token, diceValue, captureCounts) {
  const newTokens = tokens.map(t => ({ ...t }));
  const newCaptureCounts = { ...captureCounts };
  const movingToken = newTokens.find(t => t.id === token.id && t.player === token.player);
  let captured = false;
  let enteredBoard = false;

  if (movingToken.steps === -1) {
    movingToken.steps = 0;
    enteredBoard = true;
  } else {
    movingToken.steps += diceValue;
  }

  if (movingToken.steps >= 0 && movingToken.steps <= 50) {
    const pathIndex = (START_INDICES[movingToken.player] + movingToken.steps) % 52;
    if (!isSafePosition(pathIndex)) {
      newTokens.forEach(t => {
        if (t.player !== movingToken.player && t.steps >= 0 && t.steps <= 50) {
          const tPathIndex = (START_INDICES[t.player] + t.steps) % 52;
          if (tPathIndex === pathIndex) {
            t.steps = -1;
            captured = true;
            newCaptureCounts[movingToken.player] += 1;
          }
        }
      });
    }
  }

  return { tokens: newTokens, captured, enteredBoard, captureCounts: newCaptureCounts };
}

function checkWin(tokens, player) {
  return tokens.filter(t => t.player === player).every(t => t.steps >= 56);
}

function shouldGetExtraTurnFromDice(options, diceValues) {
  if (options.diceCount === 1) return diceValues[0] === 6;
  return diceValues.length === 2 && diceValues[0] === 6 && diceValues[1] === 6;
}

function shouldReverseTurn(options, consecutiveSixes) {
  return options.diceCount === 1 ? consecutiveSixes >= 3 : consecutiveSixes >= 2;
}

function rollHasSix(dv) {
  return dv.some(v => v === 6);
}

function isDoubleSix(dv) {
  return dv.length === 2 && dv[0] === 6 && dv[1] === 6;
}

function createInitialState(players, options, gameId = crypto.randomUUID()) {
  const tokens = [];
  players.forEach(player => {
    for (let i = 0; i < 4; i++) tokens.push({ id: i, player, steps: -1 });
  });
  return {
    players,
    currentPlayerIndex: 0,
    gameId,
    tokens,
    diceValues: [],
    pendingDice: [],
    selectedDiceIndex: null,
    diceRolled: false,
    winner: null,
    gameStarted: true,
    message: `${capitalize(players[0])}'s turn - Roll the dice!`,
    options,
    earnedExtraTurn: false,
    isTransitioning: false,
    turnSnapshot: tokens.map(t => ({ ...t })),
    consecutiveSixes: 0,
    rollHasSix: false,
    captureCounts: createEmptyCaptureCounts(),
  };
}

function normalizeGameState(state) {
  if (!state) return null;
  return {
    ...state,
    gameId: state.gameId || crypto.randomUUID(),
    captureCounts: state.captureCounts || createEmptyCaptureCounts(),
    turnSnapshot: Array.isArray(state.turnSnapshot) ? state.turnSnapshot.map(t => ({ ...t })) : state.tokens.map(t => ({ ...t })),
  };
}

function removeColorFromGameState(state, color) {
  const removedIndex = state.players.indexOf(color);
  if (removedIndex === -1) return state;

  const players = state.players.filter(p => p !== color);
  const tokens = state.tokens.filter(t => t.player !== color);
  let currentPlayerIndex = state.currentPlayerIndex;

  if (players.length === 0) {
    currentPlayerIndex = 0;
  } else if (removedIndex < currentPlayerIndex) {
    currentPlayerIndex -= 1;
  } else if (removedIndex === currentPlayerIndex) {
    currentPlayerIndex = Math.min(currentPlayerIndex, players.length - 1);
  } else if (currentPlayerIndex >= players.length) {
    currentPlayerIndex = 0;
  }

  const nextPlayer = players[currentPlayerIndex] || players[0] || color;
  return {
    ...state,
    players,
    tokens,
    currentPlayerIndex,
    diceRolled: false,
    diceValues: [],
    pendingDice: [],
    selectedDiceIndex: null,
    earnedExtraTurn: false,
    consecutiveSixes: 0,
    rollHasSix: false,
    turnSnapshot: tokens.map(t => ({ ...t })),
    message: players.length > 0 ? `${capitalize(nextPlayer)}'s turn - Roll the dice!` : 'Waiting for players...',
  };
}

const DATA_FILE = path.join(__dirname, 'ludo-data.json');
let persistentData = loadPersistentData();
const ADMIN_SECRET = process.env.ADMIN_PORTAL_KEY || 'ludo-admin-portal-2026';

function loadPersistentData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { accounts: {}, savedGames: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      accounts: parsed.accounts || {},
      savedGames: parsed.savedGames || {},
    };
  } catch (err) {
    console.error('Failed to load persistent game data:', err);
    return { accounts: {}, savedGames: {} };
  }
}

function persistData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(persistentData, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist game data:', err);
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
  return candidate === hash;
}

function sanitizeGameState(state) {
  const normalized = normalizeGameState(state);
  if (!normalized) return null;
  return normalized;
}

function getSavedGameUsers(game) {
  return Array.from(new Set([
    game.host,
    ...(game.participants || []),
    ...(game.players || []),
    ...(game.vacantSlots || []).map(slot => slot.username),
  ].filter(Boolean)));
}

function getSavedGameTitle(gameState) {
  const current = gameState.players[gameState.currentPlayerIndex];
  return `${capitalize(current)} to move`;
}

function listSavedGamesForUser(username) {
  return Object.values(persistentData.savedGames)
    .filter(game => !game.completed && getSavedGameUsers(game).includes(username))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(game => ({
      gameId: game.gameId,
      mode: 'online',
      updatedAt: game.updatedAt,
      title: game.title,
      roomId: game.roomId,
      gameState: game.gameState,
      paused: !!game.paused,
    }));
}

function listAdminAccounts() {
  return Object.values(persistentData.accounts)
    .sort((a, b) => a.username.localeCompare(b.username))
    .map(account => ({
      username: account.username,
      createdAt: account.createdAt,
      lastLogin: account.lastLogin,
    }));
}

function listAdminGames() {
  return Object.values(persistentData.savedGames)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(game => ({
      gameId: game.gameId,
      roomId: game.roomId,
      host: game.host,
      participants: getSavedGameUsers(game),
      paused: !!game.paused,
      completed: !!game.completed,
      updatedAt: game.updatedAt,
      title: game.title,
    }));
}

function emitAdminData(socket) {
  socket.emit('admin-data', {
    accounts: listAdminAccounts(),
    savedGames: listAdminGames(),
  });
}

function notifySavedGamesForRoom(room) {
  const usernames = new Set([room.host, ...room.players]);
  usernames.forEach(username => {
    const sid = findSocketByUsername(username);
    if (sid) io.to(sid).emit('saved-games-updated', { savedGames: listSavedGamesForUser(username) });
  });
}

function notifySavedGamesForAllUsers() {
  for (const [, user] of users) {
    const sid = findSocketByUsername(user.username);
    if (sid) io.to(sid).emit('saved-games-updated', { savedGames: listSavedGamesForUser(user.username) });
  }
}

function saveGameRecord(room) {
  if (!room || !room.gameState) return;
  const gameState = sanitizeGameState(room.gameState);
  const participants = Array.from(new Set([
    room.host,
    ...room.players,
    ...(room.vacantSlots || []).map(slot => slot.username),
  ].filter(Boolean)));
  persistentData.savedGames[gameState.gameId] = {
    gameId: gameState.gameId,
    roomId: room.id,
    host: room.host,
    players: room.players.slice(),
    participants,
    playerCount: room.playerCount,
    options: room.options,
    playerColors: room.playerColors,
    gameState,
    title: getSavedGameTitle(gameState),
    paused: !!room.paused,
    completed: false,
    vacantSlots: room.vacantSlots || [],
    updatedAt: Date.now(),
  };
  persistData();
  notifySavedGamesForRoom(room);
}

function deleteSavedGame(gameId) {
  if (!persistentData.savedGames[gameId]) return;
  delete persistentData.savedGames[gameId];
  persistData();
}

function deleteAccount(username) {
  if (!persistentData.accounts[username]) return false;
  delete persistentData.accounts[username];
  for (const [gameId, game] of Object.entries(persistentData.savedGames)) {
    const participants = game.participants || [];
    if (game.host === username || participants.includes(username)) {
      delete persistentData.savedGames[gameId];
    }
  }
  persistData();
  return true;
}

function generateRoomId() {
  let id;
  do {
    id = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (rooms.has(id));
  return id;
}

function broadcastOnlineUsers() {
  const list = [];
  for (const [, u] of users) {
    if (!u.roomId) list.push(u.username);
  }
  io.emit('online-users', { users: list });
}

function getRoomInfo(room) {
  return {
    id: room.id,
    host: room.host,
    players: room.players,
    playerColors: room.playerColors,
    options: room.options,
    started: room.started,
    playerCount: room.playerCount,
    paused: !!room.paused,
    gameId: room.gameState ? room.gameState.gameId : null,
    vacantSlots: room.vacantSlots || [],
  };
}

function findSocketByUsername(username) {
  for (const [sid, u] of users) {
    if (u.username === username) return sid;
  }
  return null;
}

function emitRoomState(room) {
  io.to(room.id).emit('room-updated', { roomId: room.id, room: getRoomInfo(room) });
}

function emitGameState(room) {
  io.to(room.id).emit('game-state', { gameState: sanitizeGameState(room.gameState) });
}

function hydrateRoomFromSavedGame(savedGame) {
  if (rooms.has(savedGame.roomId)) return rooms.get(savedGame.roomId);
  const room = {
    id: savedGame.roomId,
    host: savedGame.host,
    players: savedGame.players.slice(),
    playerCount: savedGame.playerCount,
    options: savedGame.options,
    playerColors: { ...savedGame.playerColors },
    gameState: normalizeGameState(savedGame.gameState),
    playerSockets: {},
    started: true,
    paused: !!savedGame.paused,
    vacantSlots: savedGame.vacantSlots || [],
  };
  rooms.set(room.id, room);
  return room;
}

function attachUserToRoom(room, username, socket, color) {
  const user = users.get(socket.id);
  if (!user) return;
  user.roomId = room.id;
  socket.join(room.id);
  room.playerSockets[username] = socket.id;
  if (color) room.playerColors[username] = color;
  if (!room.players.includes(username)) room.players.push(username);
}

function startGameForRoom(room) {
  const playerColorList = room.players.map(p => room.playerColors[p]);
  room.gameState = createInitialState(playerColorList, room.options);
  room.started = true;
  room.paused = false;
  room.vacantSlots = [];
  saveGameRecord(room);
  emitRoomState(room);
  emitGameState(room);
}

function processRoll(room, diceValues) {
  const state = room.gameState = normalizeGameState(room.gameState);
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
      tokens: restored,
      diceRolled: false,
      diceValues: [],
      pendingDice: [],
      selectedDiceIndex: null,
      currentPlayerIndex: npi,
      earnedExtraTurn: false,
      consecutiveSixes: 0,
      rollHasSix: false,
      turnSnapshot: restored.map(t => ({ ...t })),
      message: state.options.diceCount === 1
        ? `⚠️ 3 consecutive 6s! ${capitalize(player)}'s turn is reversed!`
        : `⚠️ 2 consecutive double 6s! ${capitalize(player)}'s turn is reversed!`,
    });
    saveGameRecord(room);
    return;
  }

  const pendingDice = state.options.diceCount === 1 ? [diceValues[0]] : [...diceValues];
  const anyValid = getValidMovesForAnyDice(state.tokens, player, pendingDice, state.captureCounts);
  const hasValidMoves = anyValid.length > 0;
  const extraFromDice = shouldGetExtraTurnFromDice(state.options, diceValues);

  let message = state.options.diceCount === 1
    ? `${capitalize(player)} rolled a ${diceValues[0]}!`
    : `${capitalize(player)} rolled ${diceValues[0]} & ${diceValues[1]}!`;
  if (!hasValidMoves) message += ' No valid moves.';
  else if (pendingDice.length === 1) message += ' Tap a token to move.';
  else message += ' Select a die, then tap a token.';

  Object.assign(state, {
    diceValues,
    pendingDice,
    selectedDiceIndex: pendingDice.length === 1 ? 0 : null,
    diceRolled: true,
    earnedExtraTurn: extraFromDice,
    consecutiveSixes: newConsecutiveSixes,
    rollHasSix: hasSix,
    message,
  });

  if (!hasValidMoves) {
    if (extraFromDice) {
      Object.assign(state, {
        diceRolled: false,
        diceValues: [],
        pendingDice: [],
        selectedDiceIndex: null,
        earnedExtraTurn: false,
        message: `${capitalize(player)} gets another turn! (${state.options.diceCount === 1 ? 'rolled 6' : 'double 6'})`,
      });
    } else {
      const npi = (state.currentPlayerIndex + 1) % state.players.length;
      Object.assign(state, {
        diceRolled: false,
        diceValues: [],
        pendingDice: [],
        selectedDiceIndex: null,
        currentPlayerIndex: npi,
        consecutiveSixes: 0,
        rollHasSix: false,
        turnSnapshot: state.tokens.map(t => ({ ...t })),
        message: `${capitalize(state.players[npi])}'s turn - Roll the dice!`,
      });
    }
  }

  saveGameRecord(room);
}

function processMove(room, token) {
  const state = room.gameState = normalizeGameState(room.gameState);
  const cp = getCurrentPlayer(state);

  let diceValue;
  let diceIndex;
  if (state.selectedDiceIndex !== null) {
    diceIndex = state.selectedDiceIndex;
    diceValue = state.pendingDice[diceIndex];
  } else {
    const idx = state.pendingDice.findIndex(dv => getValidMoves(state.tokens, cp, dv, state.captureCounts)
      .some(t => t.id === token.id && t.player === token.player));
    if (idx === -1) return;
    diceIndex = idx;
    diceValue = state.pendingDice[idx];
  }

  if (!getValidMoves(state.tokens, cp, diceValue, state.captureCounts)
    .some(t => t.id === token.id && t.player === token.player)) return;

  const { tokens: newTokens, captured, enteredBoard, captureCounts } = executeMove(state.tokens, token, diceValue, state.captureCounts);
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
    if (getValidMovesForAnyDice(newTokens, cp, newPendingDice, captureCounts).length === 0) newPendingDice.length = 0;
  }

  state.tokens = newTokens;
  state.captureCounts = captureCounts;

  if (newPendingDice.length === 0) {
    if (winner) {
      Object.assign(state, {
        pendingDice: [],
        selectedDiceIndex: null,
        diceRolled: false,
        diceValues: [],
        winner,
        message: `🎉 ${capitalize(winner)} wins the game! 🎉`,
      });
      deleteSavedGame(state.gameId);
      saveGameRecord(room);
      emitRoomState(room);
      emitGameState(room);
      return;
    }
    if (anyExtraTurn) {
      const reasons = [];
      if (extraFromDice) reasons.push(state.options.diceCount === 1 ? 'rolled 6' : 'double 6');
      if (extraFromCapture) reasons.push('captured');
      if (extraFromEntry) reasons.push('entered board');
      Object.assign(state, {
        pendingDice: [],
        selectedDiceIndex: null,
        diceValues: [],
        diceRolled: false,
        earnedExtraTurn: false,
        message: `${capitalize(cp)} gets another turn! (${reasons.join(' & ')})`,
      });
      saveGameRecord(room);
      return;
    }
    const npi = (state.currentPlayerIndex + 1) % state.players.length;
    Object.assign(state, {
      pendingDice: [],
      selectedDiceIndex: null,
      diceValues: [],
      diceRolled: false,
      currentPlayerIndex: npi,
      earnedExtraTurn: false,
      consecutiveSixes: 0,
      rollHasSix: false,
      turnSnapshot: state.tokens.map(t => ({ ...t })),
      message: `${capitalize(state.players[npi])}'s turn - Roll the dice!`,
    });
  } else {
    Object.assign(state, {
      pendingDice: newPendingDice,
      selectedDiceIndex: newPendingDice.length === 1 ? 0 : null,
      earnedExtraTurn: anyExtraTurn,
      message: newPendingDice.length === 1
        ? `Tap a token to move ${newPendingDice[0]} steps.`
        : 'Select a die, then tap a token.',
    });
  }

  saveGameRecord(room);
}

function ensureRoomHost(room) {
  if (room.host && room.players.includes(room.host)) return room.host;
  room.host = room.players[0] || room.host;
  return room.host;
}

const users = new Map();
const rooms = new Map();

function notifyRoomSavedGames(room) {
  notifySavedGamesForRoom(room);
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('create-account', ({ username, password }) => {
    const uname = typeof username === 'string' ? username.trim() : '';
    const pass = typeof password === 'string' ? password : '';
    if (uname.length < 2) return socket.emit('login-error', { message: 'Username must be at least 2 characters' });
    if (pass.length < 4) return socket.emit('login-error', { message: 'Password must be at least 4 characters' });
    if (persistentData.accounts[uname]) return socket.emit('login-error', { message: 'Account already exists' });

    persistentData.accounts[uname] = {
      username: uname,
      passwordHash: hashPassword(pass),
      createdAt: Date.now(),
      lastLogin: Date.now(),
    };
    persistData();

    users.set(socket.id, { username: uname, roomId: null, account: uname });
    socket.emit('login-success', { username: uname, savedGames: listSavedGamesForUser(uname) });
    broadcastOnlineUsers();
    console.log(`Account created: ${uname}`);
  });

  socket.on('admin-auth', ({ secret }) => {
    if (typeof secret !== 'string' || secret !== ADMIN_SECRET) {
      return socket.emit('admin-auth-error', { message: 'Invalid admin key' });
    }
    socket.data.isAdmin = true;
    emitAdminData(socket);
    socket.emit('admin-auth-success', { ok: true });
  });

  socket.on('admin-refresh', () => {
    if (!socket.data.isAdmin) return;
    emitAdminData(socket);
  });

  socket.on('admin-delete-account', ({ username }) => {
    if (!socket.data.isAdmin) return;
    const uname = typeof username === 'string' ? username.trim() : '';
    if (!uname) return;
    deleteAccount(uname);
    emitAdminData(socket);
    notifySavedGamesForAllUsers();
    broadcastOnlineUsers();
  });

  socket.on('admin-delete-saved-game', ({ gameId }) => {
    if (!socket.data.isAdmin) return;
    const id = typeof gameId === 'string' ? gameId.trim() : '';
    if (!id) return;
    deleteSavedGame(id);
    emitAdminData(socket);
    notifySavedGamesForAllUsers();
  });

  socket.on('admin-delete-local-game', ({ gameId }) => {
    if (!socket.data.isAdmin) return;
    const id = typeof gameId === 'string' ? gameId.trim() : '';
    if (!id) return;
    deleteSavedGame(id);
    emitAdminData(socket);
  });

  socket.on('login', (payload) => {
    const data = typeof payload === 'string' ? { username: payload, password: '' } : payload || {};
    const uname = typeof data.username === 'string' ? data.username.trim() : '';
    const pass = typeof data.password === 'string' ? data.password : '';
    if (uname.length < 2) return socket.emit('login-error', { message: 'Username must be at least 2 characters' });

    const account = persistentData.accounts[uname];
    if (account) {
      if (!pass) return socket.emit('login-error', { message: 'Password required for this account' });
      if (!verifyPassword(pass, account.passwordHash)) return socket.emit('login-error', { message: 'Invalid password' });
      account.lastLogin = Date.now();
      persistData();
    }

    for (const [, u] of users) {
      if (u.username === uname) return socket.emit('login-error', { message: 'Username already taken' });
    }

    users.set(socket.id, { username: uname, roomId: null, account: account ? uname : null });
    socket.emit('login-success', { username: uname, savedGames: listSavedGamesForUser(uname) });
    broadcastOnlineUsers();
    console.log(`User logged in: ${uname}`);
  });

  socket.on('create-room', ({ playerCount, options }) => {
    const user = users.get(socket.id);
    if (!user) return;
    const roomId = generateRoomId();
    rooms.set(roomId, {
      id: roomId,
      host: user.username,
      players: [user.username],
      playerCount,
      options,
      playerColors: { [user.username]: 'green' },
      gameState: null,
      playerSockets: { [user.username]: socket.id },
      started: false,
      paused: false,
      vacantSlots: [],
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
    if (!room || room.players.length >= room.playerCount) return;
    const user = users.get(socket.id);
    if (!user || room.players.includes(user.username)) return;

    let color = null;
    const vacantIndex = room.vacantSlots.findIndex(slot => !slot.username || slot.username === user.username);
    if (vacantIndex !== -1) {
      color = room.vacantSlots[vacantIndex].color;
      room.vacantSlots.splice(vacantIndex, 1);
    } else {
      const colors = ['green', 'yellow', 'red', 'blue'];
      color = colors[room.players.length];
    }

    room.players.push(user.username);
    room.playerSockets[user.username] = socket.id;
    room.playerColors[user.username] = color;
    user.roomId = roomId;
    socket.join(roomId);
    if (room.vacantSlots.length === 0) room.paused = false;

    emitRoomState(room);
    if (!room.paused) io.to(room.id).emit('game-resumed', { roomId: room.id, gameState: room.gameState, room: getRoomInfo(room) });
    saveGameRecord(room);
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

    if (room.started) return;

    room.players = room.players.filter(p => p !== user.username);
    delete room.playerColors[user.username];
    delete room.playerSockets[user.username];
    user.roomId = null;
    socket.leave(roomId);

    if (room.players.length === 0) {
      rooms.delete(roomId);
    } else {
      if (room.host === user.username) room.host = room.players[0];
      const colors = ['green', 'yellow', 'red', 'blue'];
      room.players.forEach((p, i) => { room.playerColors[p] = colors[i]; });
      emitRoomState(room);
    }
    broadcastOnlineUsers();
  });

  socket.on('start-game', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = users.get(socket.id);
    if (!user || room.host !== user.username) return;
    if (room.players.length < room.playerCount || room.vacantSlots.length > 0) return;

    startGameForRoom(room);
    io.to(roomId).emit('game-started', {
      roomId,
      gameState: room.gameState,
      playerColors: room.playerColors,
      room: getRoomInfo(room),
    });
    for (const [username, color] of Object.entries(room.playerColors)) {
      const sid = findSocketByUsername(username);
      if (sid) io.to(sid).emit('your-color', { color });
    }
    broadcastOnlineUsers();
    console.log(`Game started in room ${roomId}`);
  });

  socket.on('resume-game', ({ gameId }) => {
    const savedGame = persistentData.savedGames[gameId];
    if (!savedGame || savedGame.completed) return;
    const user = users.get(socket.id);
    if (!user) return;
    if (!getSavedGameUsers(savedGame).includes(user.username)) return;

    const room = hydrateRoomFromSavedGame(savedGame);
    const vacantSlot = room.vacantSlots.find(slot => slot.username === user.username);
    if (vacantSlot) {
      room.playerColors[user.username] = vacantSlot.color;
      room.vacantSlots = room.vacantSlots.filter(slot => slot.username !== user.username);
    }
    attachUserToRoom(room, user.username, socket, room.playerColors[user.username]);
    room.paused = room.vacantSlots.length > 0;
    room.started = true;
    emitRoomState(room);
    emitGameState(room);
    saveGameRecord(room);
    io.to(room.id).emit('game-resumed', { roomId: room.id, gameState: room.gameState, room: getRoomInfo(room) });
    broadcastOnlineUsers();
  });

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
    emitRoomState(room);
    io.to(roomId).emit('dice-rolled', { diceValues: room.gameState.diceValues });
    emitGameState(room);
  });

  socket.on('select-dice', ({ roomId, diceIndex }) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameState) return;
    const user = users.get(socket.id);
    if (!user) return;

    const state = room.gameState;
    if (room.playerColors[user.username] !== getCurrentPlayer(state)) return;

    room.gameState.selectedDiceIndex = diceIndex;
    saveGameRecord(room);
    emitGameState(room);
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
    emitRoomState(room);
    emitGameState(room);
  });

  socket.on('continue-without-player', ({ roomId, playerName }) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameState) return;
    const user = users.get(socket.id);
    if (!user || room.host !== user.username) return;

    const vacancy = room.vacantSlots.find(slot => slot.username === playerName) || room.vacantSlots[0];
    if (!vacancy) return;
    const color = vacancy.color;

    room.vacantSlots = room.vacantSlots.filter(slot => slot.username !== vacancy.username);
    room.participants = Array.from(new Set([...(room.participants || []), ...room.players, room.host].filter(Boolean)));
    room.players = room.players.filter(p => p !== vacancy.username);
    delete room.playerColors[vacancy.username];
    delete room.playerSockets[vacancy.username];
    room.gameState = removeColorFromGameState(normalizeGameState(room.gameState), color);
    room.paused = false;
    room.started = true;
    ensureRoomHost(room);

    saveGameRecord(room);
    emitRoomState(room);
    emitGameState(room);
    io.to(room.id).emit('game-resumed', { roomId: room.id, gameState: room.gameState, room: getRoomInfo(room) });
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (!user) return;
    console.log(`Disconnected: ${user.username}`);

    if (user.roomId) {
      const room = rooms.get(user.roomId);
      if (room) {
        if (room.started) {
          const color = room.playerColors[user.username];
          if (color) {
            room.paused = true;
            room.vacantSlots = [...(room.vacantSlots || []), { username: user.username, color }];
          }
          room.participants = Array.from(new Set([...(room.participants || []), room.host, ...room.players, user.username].filter(Boolean)));
          room.players = room.players.filter(p => p !== user.username);
          delete room.playerColors[user.username];
          delete room.playerSockets[user.username];
          if (room.host === user.username) room.host = room.players[0] || room.host;
          saveGameRecord(room);
          emitRoomState(room);
          const hostSid = findSocketByUsername(room.host);
          if (hostSid) io.to(hostSid).emit('player-disconnected', { username: user.username });
        } else {
          room.participants = Array.from(new Set([...(room.participants || []), room.host, ...room.players, user.username].filter(Boolean)));
          room.players = room.players.filter(p => p !== user.username);
          delete room.playerColors[user.username];
          delete room.playerSockets[user.username];
          if (room.host === user.username) room.host = room.players[0] || room.host;
          if (room.players.length === 0) {
            rooms.delete(user.roomId);
          } else {
            const colors = ['green', 'yellow', 'red', 'blue'];
            room.players.forEach((p, i) => { room.playerColors[p] = colors[i]; });
            emitRoomState(room);
          }
        }
      }
    }

    users.delete(socket.id);
    broadcastOnlineUsers();
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🎲 Ludo Server running on port ${PORT}`);
  console.log(`   Connect clients to: http://localhost:${PORT}\n`);
});