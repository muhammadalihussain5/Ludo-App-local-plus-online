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

// ─── Missed-capture (mandatory capture) helpers (server-side) ──────────────
//
// A capture is no longer forced: every legal move is allowed. Instead, if a
// capture was possible during the turn and the player did not take it, the
// PLAYER'S OWN piece that could have captured is sent back to its home base
// (the opponent piece stays put). Detection covers each individual die, the
// sum of two dice ("both" mode), and any combination/sequence of the
// accumulated dice applied to one piece.

function moveWouldCapture(tokens, token, diceValue) {
  if (token.steps === -1) return false;
  const newSteps = token.steps + diceValue;
  if (newSteps < 0 || newSteps > 50) return false;
  const pathIndex = (START_INDICES[token.player] + newSteps) % 52;
  if (isSafePosition(pathIndex)) return false;
  return tokens.some(
    ot => ot.player !== token.player && ot.steps >= 0 && ot.steps <= 50 &&
      (START_INDICES[ot.player] + ot.steps) % 52 === pathIndex
  );
}

// Every distinct total reachable by using any non-empty subset of pendingDice.
// In two-dice "choose" mode the player only ever uses one die of the pair, so
// only the individual values are reachable there.
function getReachableTotals(pendingDice, options) {
  if (options && options.diceCount === 2 && options.twoDiceMode === 'choose') {
    return [...new Set(pendingDice)];
  }
  const counts = new Map();
  for (const dv of pendingDice) counts.set(dv, (counts.get(dv) || 0) + 1);
  const unique = [...counts.keys()];
  const totals = new Set();
  const rec = (i, sum) => {
    if (i === unique.length) {
      if (sum > 0) totals.add(sum);
      return;
    }
    const value = unique[i];
    const max = counts.get(value);
    for (let k = 0; k <= max; k++) rec(i + 1, sum + value * k);
  };
  rec(0, 0);
  return [...totals].sort((a, b) => a - b);
}

// The PLAYER's OWN tokens that could capture an opponent this turn using any
// reachable total from pendingDice. Safe squares and home-base pieces are
// excluded by moveWouldCapture.
function getCapturableOwnTokens(tokens, player, pendingDice, options) {
  const totals = getReachableTotals(pendingDice, options);
  return tokens
    .filter(t => t.player === player)
    .filter(t => totals.some(total => moveWouldCapture(tokens, t, total)));
}

// Send home the moving player's own capturable tokens (identified by key in
// targetKeys) that are still on the board. This is a penalty — it does not
// count as a capture, does not increment captureCounts, and grants no extra
// turn.
function applyMissedCapturePenalty(tokens, player, targetKeys) {
  const keys = new Set(targetKeys || []);
  let removedCount = 0;
  const newTokens = tokens.map(t => {
    if (t.player === player && keys.has(`${t.player}-${t.id}`) && t.steps !== -1) {
      removedCount += 1;
      return { ...t, steps: -1 };
    }
    return t;
  });
  return { tokens: newTokens, removedCount };
}

function formatMissedCaptureMessage(player, count) {
  if (count === 0) return '';
  const noun = count > 1 ? 'pieces were' : 'piece was';
  return `⚠️ Missed capture — ${capitalize(player)}'s ${noun} sent home!`;
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

function hasPlayerFinished(tokens, player) {
  return tokens.filter(t => t.player === player).every(t => t.steps >= 56);
}

function registerFinishedPlayer(finishedOrder, player, tokens) {
  if (finishedOrder.includes(player)) return finishedOrder;
  if (!hasPlayerFinished(tokens, player)) return finishedOrder;
  return [...finishedOrder, player];
}

function emptyPositionStats() {
  return { first: 0, second: 0, third: 0, fourth: 0, gamesPlayed: 0 };
}

function bumpPositionStat(account, place) {
  if (!account) return;
  if (!account.positionStats) account.positionStats = emptyPositionStats();
  account.positionStats.gamesPlayed = (account.positionStats.gamesPlayed || 0) + 1;
  if (place === 1) account.positionStats.first += 1;
  else if (place === 2) account.positionStats.second += 1;
  else if (place === 3) account.positionStats.third += 1;
  else if (place === 4) account.positionStats.fourth += 1;
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
    pendingExtraRoll: false,
    pendingBonusReason: '',
    isTransitioning: false,
    turnSnapshot: tokens.map(t => ({ ...t })),
    consecutiveSixes: 0,
    rollHasSix: false,
    captureCounts: createEmptyCaptureCounts(),
    missedCaptureTargets: [],
    capturedThisTurn: false,
    finishedOrder: [],
  };
}

function normalizeGameState(state) {
  if (!state) return null;
  const normalized = {
    ...state,
    gameId: state.gameId || crypto.randomUUID(),
    captureCounts: state.captureCounts || createEmptyCaptureCounts(),
    finishedOrder: Array.isArray(state.finishedOrder) ? state.finishedOrder.slice() : [],
    turnSnapshot: Array.isArray(state.turnSnapshot) ? state.turnSnapshot.map(t => ({ ...t })) : state.tokens.map(t => ({ ...t })),
    // Migrate saves that predate the rename: earnedExtraTurn meant "must roll
    // again before moving", which maps to pendingExtraRoll.
    pendingExtraRoll: typeof state.pendingExtraRoll === 'boolean' ? state.pendingExtraRoll : !!state.earnedExtraTurn,
    pendingBonusReason: typeof state.pendingBonusReason === 'string' ? state.pendingBonusReason : '',
    missedCaptureTargets: Array.isArray(state.missedCaptureTargets) ? state.missedCaptureTargets.slice() : [],
    capturedThisTurn: !!state.capturedThisTurn,
  };
  delete normalized.earnedExtraTurn;
  return normalized;
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
    pendingExtraRoll: false,
    pendingBonusReason: '',
    missedCaptureTargets: [],
    capturedThisTurn: false,
    consecutiveSixes: 0,
    rollHasSix: false,
    turnSnapshot: tokens.map(t => ({ ...t })),
    message: players.length > 0 ? `${capitalize(nextPlayer)}'s turn - Roll the dice!` : 'Waiting for players...',
  };
}

const DATA_FILE = path.join(__dirname, 'ludo-data.json');
let persistentData = loadPersistentData();
const ADMIN_SECRET = process.env.ADMIN_PORTAL_KEY || 'admin864';

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
    if (sid) {
      io.to(sid).emit('saved-games-updated', { savedGames: listSavedGamesForUser(user.username) });
      const account = persistentData.accounts[user.username];
      if (account) {
        io.to(sid).emit('position-stats', { positionStats: account.positionStats || emptyPositionStats() });
      }
    }
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
    completed: !!gameState.winner,
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
    pendingReplacements: room.pendingReplacements || {},
  };
}

// ─── Replacement take-over helpers ─────────────────────────────────────────
// When players leave mid-game their colour becomes a "vacant slot". The host
// invites a replacement and explicitly chooses WHICH vacant position (colour)
// that replacement takes over, so the game can resume instead of getting stuck.

function getVacantColors(room) {
  return (room.vacantSlots || []).map(slot => slot.color);
}

// Colours that are still free to hand out: vacant slots that have not already
// been promised to another invited replacement.
function getAssignableColors(room, forUsername) {
  const promised = new Set(
    Object.entries(room.pendingReplacements || {})
      .filter(([uname]) => uname !== forUsername)
      .map(([, color]) => color)
  );
  return getVacantColors(room).filter(color => !promised.has(color));
}

// Resolve the colour an invited replacement should take over. Honours the
// host's explicit choice when it is still available, otherwise falls back to
// the first assignable vacant position.
function resolveTakeOverColor(room, username, requestedColor) {
  const assignable = getAssignableColors(room, username);
  if (assignable.length === 0) return null;
  if (requestedColor && assignable.includes(requestedColor)) return requestedColor;
  return assignable[0];
}

function clearPendingReplacement(room, username) {
  if (!room.pendingReplacements) return;
  delete room.pendingReplacements[username];
}

// Drop promises that no longer point at a real vacancy (e.g. the host chose to
// continue without that player after inviting someone).
function prunePendingReplacements(room) {
  if (!room.pendingReplacements) { room.pendingReplacements = {}; return; }
  const vacant = new Set(getVacantColors(room));
  for (const [uname, color] of Object.entries(room.pendingReplacements)) {
    if (!vacant.has(color)) delete room.pendingReplacements[uname];
  }
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

// Broadcast the current voice-chat participants (and their mute/deafen state)
// to everyone in the room. Voice audio itself is peer-to-peer WebRTC; the
// server only relays signaling messages and this participant list.
function emitVoiceUsers(room) {
  const list = Object.entries(room.voiceUsers || {}).map(([username, s]) => ({
    username,
    muted: !!s.muted,
    deafened: !!s.deafened,
  }));
  io.to(room.id).emit('voice-users', { users: list });
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
    pendingReplacements: {},
    voiceUsers: {},
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
  room.pendingReplacements = {};
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
      pendingExtraRoll: false,
      pendingBonusReason: '',
      missedCaptureTargets: [],
      capturedThisTurn: false,
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

  // Accumulate this roll onto the pool from earlier bonus rolls.
  const pendingDice = [...state.pendingDice, ...diceValues];
  const newDiceValues = [...state.pendingDice, ...diceValues];

  // If this roll earns another roll, keep rolling BEFORE moving.
  const extraFromDice = shouldGetExtraTurnFromDice(state.options, diceValues);
  if (extraFromDice) {
    Object.assign(state, {
      diceValues: newDiceValues,
      pendingDice,
      selectedDiceIndex: null,
      diceRolled: false,
      pendingExtraRoll: true,
      consecutiveSixes: newConsecutiveSixes,
      rollHasSix: hasSix,
      message: state.options.diceCount === 1
        ? `${capitalize(player)} rolled a 6! Roll again!`
        : `${capitalize(player)} rolled double 6! Roll again!`,
    });
    saveGameRecord(room);
    return;
  }

  // No more bonus rolls: the player moves with the full accumulated pool.
  const anyValid = getValidMovesForAnyDice(state.tokens, player, pendingDice, state.captureCounts);
  const hasValidMoves = anyValid.length > 0;
  const captureTargets = getCapturableOwnTokens(state.tokens, player, pendingDice, state.options)
    .map(t => `${t.player}-${t.id}`);

  let message = state.options.diceCount === 1
    ? `${capitalize(player)} rolled a ${diceValues[0]}!`
    : `${capitalize(player)} rolled ${diceValues[0]} & ${diceValues[1]}!`;
  if (!hasValidMoves) message += ' No valid moves.';
  else if (pendingDice.length === 1) message += ' Tap a token to move.';
  else message += ' Select a die, then tap a token.';

  Object.assign(state, {
    diceValues: newDiceValues,
    pendingDice,
    selectedDiceIndex: pendingDice.length === 1 ? 0 : null,
    diceRolled: true,
    pendingExtraRoll: false,
    consecutiveSixes: newConsecutiveSixes,
    rollHasSix: hasSix,
    missedCaptureTargets: captureTargets,
    capturedThisTurn: false,
    message,
  });

  if (!hasValidMoves) {
    const npi = (state.currentPlayerIndex + 1) % state.players.length;
    Object.assign(state, {
      diceRolled: false,
      diceValues: [],
      pendingDice: [],
      selectedDiceIndex: null,
      currentPlayerIndex: npi,
      consecutiveSixes: 0,
      rollHasSix: false,
      missedCaptureTargets: [],
      capturedThisTurn: false,
      turnSnapshot: state.tokens.map(t => ({ ...t })),
      message: `${capitalize(state.players[npi])}'s turn - Roll the dice!`,
    });
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
    // Prefer the die that makes this move a capture (a convenience, not a
    // restriction — captures are no longer mandatory); otherwise use the
    // first die that makes the token a valid move.
    let idx = -1;
    for (let i = 0; i < state.pendingDice.length; i++) {
      const dv = state.pendingDice[i];
      const isValid = getValidMoves(state.tokens, cp, dv, state.captureCounts)
        .some(t => t.id === token.id && t.player === token.player);
      if (!isValid) continue;
      if (moveWouldCapture(state.tokens, token, dv)) { idx = i; break; }
      if (idx === -1) idx = i;
    }
    if (idx === -1) return;
    diceIndex = idx;
    diceValue = state.pendingDice[idx];
  }

  if (!getValidMoves(state.tokens, cp, diceValue, state.captureCounts)
    .some(t => t.id === token.id && t.player === token.player)) return;

  const { tokens: movedTokens, captured, enteredBoard, captureCounts } = executeMove(state.tokens, token, diceValue, state.captureCounts);

  const newTokens = movedTokens;
  const newCaptureCounts = captureCounts;
  const capturedThisTurn = state.capturedThisTurn || captured;

  // ─── Ranking & game-end logic ─────────────────────────────────────────
  // The game ends as soon as the second-last player finishes (only one
  // player is left unranked).
  const playerFinished = hasPlayerFinished(newTokens, cp);
  const finishedOrder = playerFinished
    ? registerFinishedPlayer(state.finishedOrder, cp, newTokens)
    : state.finishedOrder;
  const shouldEndGame = finishedOrder.length >= state.players.length - 1;
  const winner = shouldEndGame ? (finishedOrder[0] || null) : null;

  // Capture/entry bonuses happen AFTER a move, so they can't be pre-rolled.
  // Track the reason so it survives a multi-dice move phase.
  let pendingBonusReason = state.pendingBonusReason;
  if (captured && state.options.extraTurnOnCapture) pendingBonusReason = 'captured';
  else if (enteredBoard && state.options.extraRollOnEntry) pendingBonusReason = 'entered board';

  const newPendingDice = [...state.pendingDice];
  newPendingDice.splice(diceIndex, 1);

  const isChooseMode = state.options.diceCount === 2 && state.options.twoDiceMode === 'choose';
  if (isChooseMode && !state.rollHasSix && newPendingDice.length > 0) newPendingDice.length = 0;

  if (newPendingDice.length > 0) {
    if (getValidMovesForAnyDice(newTokens, cp, newPendingDice, newCaptureCounts).length === 0) newPendingDice.length = 0;
  }

  state.tokens = newTokens;
  state.captureCounts = newCaptureCounts;
  state.finishedOrder = finishedOrder;
  state.pendingBonusReason = pendingBonusReason;
  state.capturedThisTurn = capturedThisTurn;

  if (newPendingDice.length === 0) {
    // ─── Missed-capture penalty ─────────────────────────────────────────
    // A capture is no longer forced. If the player ends the turn without
    // capturing, any of their OWN pieces that could have captured (when the
    // move phase began) and are still on the board are sent home.
    const penalty = capturedThisTurn
      ? { tokens: state.tokens, removedCount: 0 }
      : applyMissedCapturePenalty(state.tokens, cp, state.missedCaptureTargets);
    state.tokens = penalty.tokens;
    state.missedCaptureTargets = [];
    state.capturedThisTurn = false;
    const missedMessage = formatMissedCaptureMessage(cp, penalty.removedCount);

    if (winner) {
      // Build final ranking: everyone who finished (1st, 2nd, …) + the
      // single remaining player (last place).
      const remaining = state.players.filter(p => !finishedOrder.includes(p));
      const ranking = [...finishedOrder, ...remaining];
      const rankingText = ranking.map((p, i) => `${i + 1}. ${capitalize(p)}`).join(' • ');
      Object.assign(state, {
        pendingDice: [],
        selectedDiceIndex: null,
        diceRolled: false,
        diceValues: [],
        winner,
        message: `🏆 Game over! ${rankingText}`,
      });
      // Update position stats for every participating account.
      for (let i = 0; i < ranking.length; i++) {
        const place = i + 1;
        const colorForPlace = ranking[i];
        // Find the username whose color matches.
        let username = null;
        for (const [uname, col] of Object.entries(room.playerColors || {})) {
          if (col === colorForPlace) { username = uname; break; }
        }
        if (username && persistentData.accounts[username]) {
          bumpPositionStat(persistentData.accounts[username], place);
        }
      }
      // Mark the finished game as completed so it stops appearing as a
      // resumable game (but keep a record for the admin panel).
      if (persistentData.savedGames[state.gameId]) {
        persistentData.savedGames[state.gameId].completed = true;
        persistentData.savedGames[state.gameId].gameState = sanitizeGameState(state);
        persistentData.savedGames[state.gameId].updatedAt = Date.now();
      }
      persistData();
      emitRoomState(room);
      emitGameState(room);
      // Notify each user that their stats changed.
      notifySavedGamesForAllUsers();
      // Clean up the finished room so it doesn't linger in memory, and free
      // the connected players back into the lobby (they can start fresh
      // without refreshing the page).
      for (const username of room.players) {
        const sid = findSocketByUsername(username);
        if (sid) {
          const u = users.get(sid);
          if (u) u.roomId = null;
        }
      }
      // The room is gone, so tell connected clients to tear down their
      // peer-to-peer voice sessions.
      io.to(room.id).emit('voice-reset', {});
      rooms.delete(room.id);
      broadcastOnlineUsers();
      return;
    }
    if (playerFinished && !shouldEndGame) {
      const place = finishedOrder.length;
      const suffix = ['1st', '2nd', '3rd', '4th'][place - 1] || `${place}th`;
      let npi = (state.currentPlayerIndex + 1) % state.players.length;
      // Skip already-finished players.
      let safety = state.players.length;
      while (safety-- > 0 && finishedOrder.includes(state.players[npi])) {
        const next = (npi + 1) % state.players.length;
        if (next === npi) break;
        npi = next;
      }
      const nextPlayer = state.players[npi];
      Object.assign(state, {
        pendingDice: [],
        selectedDiceIndex: null,
        diceValues: [],
        diceRolled: false,
        currentPlayerIndex: npi,
        pendingExtraRoll: false,
        pendingBonusReason: '',
        consecutiveSixes: 0,
        rollHasSix: false,
        turnSnapshot: state.tokens.map(t => ({ ...t })),
        message: `🎉 ${capitalize(cp)} finished in ${suffix} place! ${capitalize(nextPlayer)}'s turn - Roll the dice!${missedMessage ? ' ' + missedMessage : ''}`,
      });
      saveGameRecord(room);
      return;
    }
    if (pendingBonusReason) {
      Object.assign(state, {
        pendingDice: [],
        selectedDiceIndex: null,
        diceValues: [],
        diceRolled: false,
        pendingExtraRoll: false,
        pendingBonusReason: '',
        message: `${capitalize(cp)} gets another turn! (${pendingBonusReason})${missedMessage ? ' ' + missedMessage : ''}`,
      });
      saveGameRecord(room);
      return;
    }
    // Find next non-finished player
    let npi = (state.currentPlayerIndex + 1) % state.players.length;
    let safety = state.players.length;
    while (safety-- > 0 && finishedOrder.includes(state.players[npi])) {
      npi = (npi + 1) % state.players.length;
    }
    Object.assign(state, {
      pendingDice: [],
      selectedDiceIndex: null,
      diceValues: [],
      diceRolled: false,
      currentPlayerIndex: npi,
      pendingExtraRoll: false,
      pendingBonusReason: '',
      consecutiveSixes: 0,
      rollHasSix: false,
      turnSnapshot: state.tokens.map(t => ({ ...t })),
      message: `${capitalize(state.players[npi])}'s turn - Roll the dice!${missedMessage ? ' ' + missedMessage : ''}`,
    });
  } else {
    Object.assign(state, {
      pendingDice: newPendingDice,
      selectedDiceIndex: newPendingDice.length === 1 ? 0 : null,
      pendingBonusReason,
      message: (newPendingDice.length === 1
        ? `Tap a token to move ${newPendingDice[0]} steps.`
        : 'Select a die, then tap a token.'),
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
      positionStats: emptyPositionStats(),
    };
    persistData();

    users.set(socket.id, { username: uname, roomId: null, account: uname });
    socket.emit('login-success', { username: uname, savedGames: listSavedGamesForUser(uname), positionStats: persistentData.accounts[uname].positionStats });
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
    if (!account) {
      return socket.emit('login-error', { message: 'No account found for this username. Please create an account first.', accountNotFound: true });
    }
    if (!pass) return socket.emit('login-error', { message: 'Password required for this account' });
    if (!verifyPassword(pass, account.passwordHash)) return socket.emit('login-error', { message: 'Invalid password' });
    account.lastLogin = Date.now();
    persistData();

    for (const [, u] of users) {
      if (u.username === uname) return socket.emit('login-error', { message: 'Username already taken' });
    }

    users.set(socket.id, { username: uname, roomId: null, account: uname });
    socket.emit('login-success', { username: uname, savedGames: listSavedGamesForUser(uname), positionStats: account.positionStats || emptyPositionStats() });
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
      pendingReplacements: {},
      voiceUsers: {},
    });
    user.roomId = roomId;
    socket.join(roomId);
    socket.emit('room-created', { roomId, room: getRoomInfo(rooms.get(roomId)) });
    broadcastOnlineUsers();
    console.log(`Room created: ${roomId} by ${user.username}`);
  });

  socket.on('invite-player', ({ roomId, username, takeOverColor }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = users.get(socket.id);
    if (!user || room.host !== user.username) return;
    if (room.players.includes(username)) return;

    // Only reserve a position for someone who is actually online, otherwise
    // an unreachable invite would block a slot forever.
    const targetSid = findSocketByUsername(username);
    if (!targetSid) {
      return socket.emit('invite-error', { roomId, message: `${username} is not online.` });
    }

    // ─── Replacement take-over ──────────────────────────────────────────
    // For a game already in progress the host must decide which previous
    // position (colour) the invited replacement takes over. We record that
    // promise now so the slot is reserved and the game can resume cleanly.
    let assignedColor = null;
    if (room.started && getVacantColors(room).length > 0) {
      prunePendingReplacements(room);
      assignedColor = resolveTakeOverColor(room, username, takeOverColor);
      if (!assignedColor) {
        return socket.emit('invite-error', { roomId, message: 'No free position left to take over.' });
      }
      room.pendingReplacements = room.pendingReplacements || {};
      room.pendingReplacements[username] = assignedColor;
    }

    io.to(targetSid).emit('room-invite', {
      roomId,
      from: user.username,
      playerCount: room.playerCount,
      takeOverColor: assignedColor,
    });

    if (assignedColor) emitRoomState(room);
  });

  socket.on('accept-invite', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = users.get(socket.id);
    if (!user || room.players.includes(user.username)) return;

    const isReplacement = room.started && getVacantColors(room).length > 0;
    if (!isReplacement && room.players.length >= room.playerCount) return;

    let color = null;
    if (isReplacement) {
      // Take over the exact position the host picked for this player.
      prunePendingReplacements(room);
      const promised = (room.pendingReplacements || {})[user.username];
      color = resolveTakeOverColor(room, user.username, promised);
      if (!color) return;
      clearPendingReplacement(room, user.username);
      room.vacantSlots = room.vacantSlots.filter(slot => slot.color !== color);
    } else {
      const vacantIndex = room.vacantSlots.findIndex(slot => !slot.username || slot.username === user.username);
      if (vacantIndex !== -1) {
        color = room.vacantSlots[vacantIndex].color;
        room.vacantSlots.splice(vacantIndex, 1);
      } else {
        const colors = ['green', 'yellow', 'red', 'blue'];
        color = colors[room.players.length];
      }
    }

    room.players.push(user.username);
    room.playerSockets[user.username] = socket.id;
    room.playerColors[user.username] = color;
    user.roomId = roomId;
    socket.join(roomId);
    prunePendingReplacements(room);
    if (room.vacantSlots.length === 0) room.paused = false;

    // The replacement plays the colour they took over, so tell them about it.
    if (room.started) socket.emit('your-color', { color });

    emitRoomState(room);
    if (room.started && !room.paused) {
      emitGameState(room);
      io.to(room.id).emit('game-resumed', { roomId: room.id, gameState: sanitizeGameState(room.gameState), room: getRoomInfo(room) });
    }
    saveGameRecord(room);
    broadcastOnlineUsers();
    console.log(`${user.username} joined room ${roomId}${isReplacement ? ` as replacement for ${color}` : ''}`);
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
    if (room.voiceUsers && room.voiceUsers[user.username]) {
      delete room.voiceUsers[user.username];
      emitVoiceUsers(room);
    }
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
    prunePendingReplacements(room);
    const promisedColor = (room.pendingReplacements || {})[user.username];
    const vacantSlot = room.vacantSlots.find(slot => slot.username === user.username)
      || (promisedColor ? room.vacantSlots.find(slot => slot.color === promisedColor) : null);
    if (vacantSlot) {
      room.playerColors[user.username] = vacantSlot.color;
      room.vacantSlots = room.vacantSlots.filter(slot => slot.color !== vacantSlot.color);
      clearPendingReplacement(room, user.username);
    }
    attachUserToRoom(room, user.username, socket, room.playerColors[user.username]);
    room.paused = room.vacantSlots.length > 0;
    room.started = true;
    emitRoomState(room);
    emitGameState(room);
    saveGameRecord(room);
    io.to(room.id).emit('game-resumed', { roomId: room.id, gameState: room.gameState, room: getRoomInfo(room) });
    broadcastOnlineUsers();
    // Re-send the user's own position stats so the lobby stays in sync.
    const account = persistentData.accounts[user.username];
    if (account) socket.emit('position-stats', { positionStats: account.positionStats || emptyPositionStats() });
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

  // ─── Voice chat signaling (WebRTC peer-to-peer) ─────────────────────────
  // The audio stream never touches this server — it only relays SDP offers,
  // answers and ICE candidates between players in the same room, and keeps a
  // room-local list of who is in voice chat.

  socket.on('voice-join', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = users.get(socket.id);
    if (!user || !room.players.includes(user.username)) return;
    room.voiceUsers = room.voiceUsers || {};
    room.voiceUsers[user.username] = { muted: false, deafened: false };
    emitVoiceUsers(room);
  });

  socket.on('voice-leave', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = users.get(socket.id);
    if (!user) return;
    room.voiceUsers = room.voiceUsers || {};
    if (room.voiceUsers[user.username]) {
      delete room.voiceUsers[user.username];
      emitVoiceUsers(room);
    }
  });

  socket.on('voice-state', ({ roomId, muted, deafened }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = users.get(socket.id);
    if (!user) return;
    room.voiceUsers = room.voiceUsers || {};
    if (room.voiceUsers[user.username]) {
      room.voiceUsers[user.username].muted = !!muted;
      room.voiceUsers[user.username].deafened = !!deafened;
      emitVoiceUsers(room);
    }
  });

  socket.on('voice-signal', ({ roomId, to, signal }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = users.get(socket.id);
    if (!user) return;
    if (!signal || typeof to !== 'string') return;
    const targetSid = findSocketByUsername(to);
    if (!targetSid) return;
    io.to(targetSid).emit('voice-signal', { from: user.username, signal });
  });

  socket.on('continue-without-player', ({ roomId, playerName }) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameState) return;
    const user = users.get(socket.id);
    if (!user || room.host !== user.username) return;

    const vacancy = room.vacantSlots.find(slot => slot.username === playerName)
      || room.vacantSlots.find(slot => slot.color === playerName)
      || room.vacantSlots[0];
    if (!vacancy) return;
    const color = vacancy.color;

    room.vacantSlots = room.vacantSlots.filter(slot => slot.color !== color);
    prunePendingReplacements(room);
    room.participants = Array.from(new Set([...(room.participants || []), ...room.players, room.host].filter(Boolean)));
    room.players = room.players.filter(p => p !== vacancy.username);
    delete room.playerColors[vacancy.username];
    delete room.playerSockets[vacancy.username];
    room.gameState = removeColorFromGameState(normalizeGameState(room.gameState), color);
    room.paused = room.vacantSlots.length > 0;
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
        if (room.voiceUsers && room.voiceUsers[user.username]) {
          delete room.voiceUsers[user.username];
          emitVoiceUsers(room);
        }
        if (room.started) {
          const color = room.playerColors[user.username];
          if (color) {
            room.paused = true;
            room.vacantSlots = [...(room.vacantSlots || []), { username: user.username, color }];
            clearPendingReplacement(room, user.username);
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
