import { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  type PlayerColor, type GameState, type Token, type GameOptions,
  PLAYER_COLORS, START_INDICES, getCellInfo, getTokenPosition,
  getValidMoves, getValidMovesForAnyDice, executeMove,
  createInitialState, createEmptyCaptureCounts, getCurrentPlayer, isHumanTurn, capitalize,
  shouldReverseTurn, shouldGetExtraTurnFromDice, rollHasSix, isDoubleSix,
  getAIMove, getAIMoveTwoDice,
  getCapturableOwnTokens, applyMissedCapturePenalty, formatMissedCaptureMessage, moveWouldCapture,
  registerFinishedPlayer, hasPlayerFinished,
} from './gameLogic';
import { useVoiceChat, type VoiceChatApi } from './voice';
import { VoicePanel } from './VoicePanel';

const DEFAULT_OPTIONS: GameOptions = {
  extraRollOnEntry: true, extraTurnOnCapture: true,
  diceCount: 1, twoDiceMode: 'both', isAIMode: true,
};

// ─── Types ───────────────────────────────────────────────────────────────────

type Screen = 'start' | 'options' | 'online-login' | 'online-lobby' | 'game';

type SavedGameMode = 'local' | 'online';

interface SavedGameSummary {
  gameId: string;
  mode: SavedGameMode;
  updatedAt: number;
  title: string;
  gameState: GameState;
  roomId?: string;
}

interface RoomInfo {
  id: string; host: string; players: string[];
  playerColors: Record<string, PlayerColor>; options: GameOptions;
  started: boolean; playerCount: number;
  paused?: boolean;
  gameId?: string;
  vacantSlots?: { username: string; color: PlayerColor }[];
  pendingReplacements?: Record<string, PlayerColor>;
}

interface InviteInfo { roomId: string; from: string; playerCount: number; takeOverColor?: PlayerColor | null; }

interface PositionStats {
  first: number;
  second: number;
  third: number;
  fourth: number;
  gamesPlayed: number;
}

function emptyPositionStats(): PositionStats {
  return { first: 0, second: 0, third: 0, fourth: 0, gamesPlayed: 0 };
}

interface AdminAccountRecord {
  username: string;
  createdAt: number;
  lastLogin: number;
}

interface AdminGameRecord {
  gameId: string;
  roomId: string;
  host: string;
  participants: string[];
  paused: boolean;
  completed: boolean;
  updatedAt: number;
  title: string;
}

interface AdminDataPayload {
  accounts: AdminAccountRecord[];
  savedGames: AdminGameRecord[];
}

const LOCAL_SAVE_KEY = 'traditional-ludo.saved-local-games';
const ADMIN_SHORTCUT = 'Ctrl+Shift+Alt+A';

function getDefaultServerUrl() {
  if (typeof window === 'undefined') return 'https://ludo-app-local-plus-online.onrender.com/';
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:3001';
  }
  return 'https://ludo-app-local-plus-online.onrender.com/';
}

function createBlankCaptureCounts(): Record<PlayerColor, number> {
  return createEmptyCaptureCounts();
}

function normalizeGameState(state: GameState): GameState {
  const raw = state as GameState & { earnedExtraTurn?: boolean };
  const normalized: GameState = {
    ...state,
    gameId: state.gameId || (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
    captureCounts: state.captureCounts || createBlankCaptureCounts(),
    finishedOrder: state.finishedOrder || [],
    // Migrate saves that predate the rename: earnedExtraTurn meant "must roll
    // again before moving" under the old flow, which maps to pendingExtraRoll.
    pendingExtraRoll: typeof state.pendingExtraRoll === 'boolean' ? state.pendingExtraRoll : !!raw.earnedExtraTurn,
    pendingBonusReason: typeof state.pendingBonusReason === 'string' ? state.pendingBonusReason : '',
    missedCaptureTargets: Array.isArray(state.missedCaptureTargets) ? [...state.missedCaptureTargets] : [],
    capturedThisTurn: !!state.capturedThisTurn,
  };
  delete (normalized as GameState & { earnedExtraTurn?: boolean }).earnedExtraTurn;
  return normalized;
}

function buildSavedGameTitle(state: GameState): string {
  const current = state.players[state.currentPlayerIndex];
  return `${capitalize(current)} to move`;
}

function loadLocalSavedGames(): SavedGameSummary[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_SAVE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedGameSummary[];
    return Array.isArray(parsed) ? parsed.map(item => ({ ...item, gameState: normalizeGameState(item.gameState) })) : [];
  } catch {
    return [];
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName;
  return target.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

function saveLocalGameSnapshot(gameState: GameState) {
  if (typeof window === 'undefined') return;
  const current = loadLocalSavedGames().filter(game => game.gameId !== gameState.gameId);
  if (gameState.winner) {
    window.localStorage.setItem(LOCAL_SAVE_KEY, JSON.stringify(current));
    return;
  }
  current.unshift({
    gameId: gameState.gameId,
    mode: 'local',
    updatedAt: Date.now(),
    title: buildSavedGameTitle(gameState),
    gameState: normalizeGameState(gameState),
  });
  window.localStorage.setItem(LOCAL_SAVE_KEY, JSON.stringify(current.slice(0, 8)));
}

function removeLocalGameSnapshot(gameId: string) {
  if (typeof window === 'undefined') return;
  const current = loadLocalSavedGames().filter(game => game.gameId !== gameId);
  window.localStorage.setItem(LOCAL_SAVE_KEY, JSON.stringify(current));
}

// ─── Toggle Switch ───────────────────────────────────────────────────────────

function ToggleSwitch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!value)} className={`relative w-12 h-6 rounded-full transition-colors duration-300 ${value ? 'bg-green-500' : 'bg-gray-500'}`}>
      <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-300 ${value ? 'translate-x-6' : 'translate-x-0.5'}`} />
    </button>
  );
}

// ─── Dice Face ───────────────────────────────────────────────────────────────

function DiceFace({ value, rolling, selected, used, onClick }: {
  value: number | null; rolling: boolean; selected?: boolean; used?: boolean; onClick?: () => void;
}) {
  const dotPositions: Record<number, [number, number][]> = {
    1: [[50,50]], 2: [[28,28],[72,72]], 3: [[28,28],[50,50],[72,72]],
    4: [[28,28],[72,28],[28,72],[72,72]], 5: [[28,28],[72,28],[50,50],[28,72],[72,72]],
    6: [[28,28],[72,28],[28,50],[72,50],[28,72],[72,72]],
  };
  return (
    <div onClick={onClick} className={`relative rounded-xl border-2 shadow-lg flex items-center justify-center transition-all duration-200 ${rolling ? 'dice-shake' : ''} ${selected ? 'ring-3 ring-yellow-400 scale-110' : ''} ${used ? 'opacity-30 scale-90' : ''} ${onClick ? 'cursor-pointer hover:scale-105' : ''}`}
      style={{ width: 56, height: 56, background: used ? 'linear-gradient(135deg,#999,#888)' : 'linear-gradient(135deg,#fff,#f0f0f0)', borderColor: selected ? '#FACC15' : used ? '#999' : '#ccc' }}>
      {value && dotPositions[value]?.map(([x, y], i) => (
        <div key={i} className="absolute rounded-full" style={{ width: 9, height: 9, left: `${x}%`, top: `${y}%`, transform: 'translate(-50%,-50%)', backgroundColor: used ? '#666' : '#333' }} />
      ))}
    </div>
  );
}

// ─── Token Piece ─────────────────────────────────────────────────────────────

function TokenPiece({ token, isValid, onClick, size, offsetX, offsetY }: {
  token: Token; isValid: boolean; onClick?: () => void; size: number; offsetX: number; offsetY: number;
}) {
  const colors = PLAYER_COLORS[token.player];
  return (
    <div className={`absolute rounded-full flex items-center justify-center font-bold border-2 transition-all duration-300 ${isValid ? 'cursor-pointer animate-pulse-glow' : ''} ${token.steps >= 56 ? 'opacity-60 scale-75' : ''}`}
      style={{ width: size, height: size, backgroundColor: isValid ? colors.bg : colors.dark, borderColor: isValid ? '#fff' : colors.dark, color: '#fff', left: `calc(50% + ${offsetX}px)`, top: `calc(50% + ${offsetY}px)`, transform: 'translate(-50%,-50%)', boxShadow: isValid ? `0 0 10px ${colors.bg},0 0 20px ${colors.bg}80` : '0 1px 3px rgba(0,0,0,0.4)', zIndex: isValid ? 20 : 10, fontSize: size * 0.45, textShadow: '0 1px 1px rgba(0,0,0,0.3)' }}
      onClick={onClick}>
      {token.id + 1}
    </div>
  );
}

// ─── Board Cell ──────────────────────────────────────────────────────────────

function BoardCell({ r, c, cellSize, tokensOnCell, validTokenIds, onTokenClick }: {
  r: number; c: number; cellSize: number; tokensOnCell: Token[]; validTokenIds: Set<string>; onTokenClick: (token: Token) => void;
}) {
  const cellInfo = getCellInfo(r, c);
  const colors = cellInfo.color ? PLAYER_COLORS[cellInfo.color] : null;
  let bgStyle: React.CSSProperties = {};
  let content: React.ReactNode = null;

  switch (cellInfo.type) {
    case 'homeBase': bgStyle = { backgroundColor: colors!.bg, border: `1px solid ${colors!.dark}40` }; break;
    case 'homeBaseInner': bgStyle = { backgroundColor: '#fff', border: `1px solid ${colors!.border}60`, boxShadow: `inset 0 0 0 1px ${colors!.light}` }; break;
    case 'path': {
      let sc: PlayerColor | null = null;
      if (cellInfo.isStart) { for (const [p, idx] of Object.entries(START_INDICES)) { if (idx === cellInfo.pathIndex) { sc = p as PlayerColor; break; } } }
      bgStyle = { backgroundColor: sc ? PLAYER_COLORS[sc].light : '#fff', border: '1px solid #d0d0d0' };
      if (cellInfo.isSafe && !cellInfo.isStart) content = <span style={{ color: '#bbb', fontSize: cellSize * 0.55, lineHeight: 1 }}>★</span>;
      if (cellInfo.isStart && sc) content = <div className="rounded-full" style={{ width: cellSize * 0.6, height: cellSize * 0.6, backgroundColor: PLAYER_COLORS[sc].bg, border: `2px solid ${PLAYER_COLORS[sc].dark}`, opacity: 0.3 }} />;
      break;
    }
    case 'homeStretch': {
      const ad = cellInfo.color === 'green' ? '→' : cellInfo.color === 'yellow' ? '↓' : cellInfo.color === 'red' ? '←' : '↑';
      bgStyle = { backgroundColor: colors!.light, border: `1px solid ${colors!.border}80` };
      if (cellInfo.hsIndex !== undefined && cellInfo.hsIndex < 5) content = <span style={{ color: colors!.dark, fontSize: cellSize * 0.35, opacity: 0.4, lineHeight: 1 }}>{ad}</span>;
      break;
    }
    case 'center': {
      const cc: Record<string, string> = { '6,6': PLAYER_COLORS.green.bg, '6,7': PLAYER_COLORS.yellow.bg, '6,8': PLAYER_COLORS.red.bg, '7,6': PLAYER_COLORS.green.bg, '7,7': '#FFD700', '7,8': PLAYER_COLORS.red.bg, '8,6': PLAYER_COLORS.blue.bg, '8,7': PLAYER_COLORS.blue.bg, '8,8': PLAYER_COLORS.red.bg };
      bgStyle = { backgroundColor: cc[`${r},${c}`] || '#fff', border: '1px solid #999' };
      if (r === 7 && c === 7) content = <span style={{ fontSize: cellSize * 0.65 }}>🏠</span>;
      break;
    }
    default: bgStyle = { backgroundColor: 'transparent', border: 'none' };
  }

  const tokenElements = tokensOnCell.map((token, idx) => {
    const key = `${token.player}-${token.id}`;
    const isValid = validTokenIds.has(key);
    const count = tokensOnCell.length;
    const offsets: [number, number][] = count === 1 ? [[0,0]] : count === 2 ? [[-cellSize*0.12,0],[cellSize*0.12,0]] : count === 3 ? [[-cellSize*0.12,-cellSize*0.08],[cellSize*0.12,-cellSize*0.08],[0,cellSize*0.12]] : [[-cellSize*0.12,-cellSize*0.12],[cellSize*0.12,-cellSize*0.12],[-cellSize*0.12,cellSize*0.12],[cellSize*0.12,cellSize*0.12]];
    const ts = count > 2 ? cellSize * 0.42 : cellSize * 0.55;
    return <TokenPiece key={key} token={token} isValid={isValid} onClick={isValid ? () => onTokenClick(token) : undefined} size={ts} offsetX={offsets[idx][0]} offsetY={offsets[idx][1]} />;
  });

  return <div className="relative flex items-center justify-center overflow-hidden" style={{ width: cellSize, height: cellSize, ...bgStyle, boxSizing: 'border-box' }}>{content}{tokenElements}</div>;
}

// ─── Start Screen ────────────────────────────────────────────────────────────

function StartScreen({ onLocal, onOnline, savedGames, onResumeLocal }: {
  onLocal: () => void; onOnline: () => void; savedGames: SavedGameSummary[]; onResumeLocal: (gameId: string) => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-pink-900 p-4">
      <div className="text-center mb-8">
        <h1 className="text-6xl font-extrabold text-white mb-2 drop-shadow-lg">🎲 Ludo</h1>
        <p className="text-purple-200 text-lg">Classic Board Game</p>
      </div>
      <div className="bg-white/10 backdrop-blur-lg rounded-3xl p-8 shadow-2xl border border-white/20 max-w-sm w-full">
        <h2 className="text-white text-xl font-semibold mb-6 text-center">Choose Mode</h2>
        <div className="space-y-4">
          <button onClick={onLocal} className="w-full py-4 px-6 bg-gradient-to-r from-green-500 to-emerald-600 rounded-2xl text-white font-bold text-lg shadow-lg hover:scale-105 transition-transform active:scale-95">
            📱 Local Play
            <div className="text-sm opacity-80 mt-1">vs AI or Pass & Play</div>
          </button>
          <button onClick={onOnline} className="w-full py-4 px-6 bg-gradient-to-r from-blue-500 to-indigo-600 rounded-2xl text-white font-bold text-lg shadow-lg hover:scale-105 transition-transform active:scale-95">
            🌐 Online Play
            <div className="text-sm opacity-80 mt-1">Play with friends online</div>
          </button>
        </div>
        {savedGames.length > 0 && (
          <div className="mt-5 bg-black/20 rounded-2xl p-4 border border-white/10">
            <h3 className="text-white text-sm font-semibold mb-3">Resume Local Game</h3>
            <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
              {savedGames.map(game => (
                <button key={game.gameId} onClick={() => onResumeLocal(game.gameId)} className="w-full text-left px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20 transition-colors">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-white text-sm font-medium">{game.title}</span>
                    <span className="text-white/40 text-xs">{new Date(game.updatedAt).toLocaleString()}</span>
                  </div>
                  <div className="text-white/40 text-xs mt-1">Game ID: {game.gameId}</div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="mt-8 flex gap-3">
        {(['green','yellow','red','blue'] as PlayerColor[]).map(c => (
          <div key={c} className="w-10 h-10 rounded-full border-2 border-white/30 shadow-lg" style={{ backgroundColor: PLAYER_COLORS[c].bg }} />
        ))}
      </div>
    </div>
  );
}

// ─── Options Screen ──────────────────────────────────────────────────────────

function OptionsScreen({ onStart, onBack }: { onStart: (o: GameOptions, pc: number) => void; onBack: () => void }) {
  const [playerCount, setPlayerCount] = useState(4);
  const [options, setOptions] = useState<GameOptions>({ ...DEFAULT_OPTIONS });
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-slate-800 via-slate-900 to-slate-800 p-4">
      <div className="bg-white/10 backdrop-blur-lg rounded-3xl p-6 shadow-2xl border border-white/20 max-w-md w-full max-h-[90vh] overflow-y-auto">
        <h2 className="text-white text-xl font-bold mb-1 text-center">⚙️ Game Options</h2>
        <div className="mb-5 bg-white/5 rounded-2xl p-4">
          <h3 className="text-white font-semibold mb-3 text-sm">👥 Number of Players</h3>
          <div className="flex gap-3">
            {[2,3,4].map(n => (
              <button key={n} onClick={() => setPlayerCount(n)} className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all ${playerCount === n ? 'bg-purple-500 text-white shadow-lg' : 'bg-white/10 text-white/60'}`}>{n} Players</button>
            ))}
          </div>
        </div>
        <div className="mb-5 bg-white/5 rounded-2xl p-4">
          <h3 className="text-white font-semibold mb-3 text-sm">👥 Play Mode</h3>
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => setOptions(o => ({...o, isAIMode: true}))} className={`py-3 px-3 rounded-xl text-sm font-medium transition-all ${options.isAIMode ? 'bg-green-500 text-white shadow-lg scale-105' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}>🤖 vs AI<div className="text-xs opacity-70 mt-0.5">You play as Green</div></button>
            <button onClick={() => setOptions(o => ({...o, isAIMode: false}))} className={`py-3 px-3 rounded-xl text-sm font-medium transition-all ${!options.isAIMode ? 'bg-blue-500 text-white shadow-lg scale-105' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}>📱 Pass & Play<div className="text-xs opacity-70 mt-0.5">Pass device between turns</div></button>
          </div>
        </div>
        <div className="mb-5 bg-white/5 rounded-2xl p-4 space-y-4">
          <h3 className="text-white font-semibold text-sm">🎯 Bonus Turn Rules</h3>
          <div className="flex items-center justify-between"><div><p className="text-white text-sm">Extra roll on entry</p><p className="text-white/40 text-xs">Another roll when piece enters board</p></div><ToggleSwitch value={options.extraRollOnEntry} onChange={v => setOptions(o => ({...o, extraRollOnEntry: v}))} /></div>
          <div className="flex items-center justify-between"><div><p className="text-white text-sm">Extra turn on capture</p><p className="text-white/40 text-xs">Another roll when you capture</p></div><ToggleSwitch value={options.extraTurnOnCapture} onChange={v => setOptions(o => ({...o, extraTurnOnCapture: v}))} /></div>
        </div>
        <div className="mb-5 bg-white/5 rounded-2xl p-4 space-y-4">
          <h3 className="text-white font-semibold text-sm">🎲 Dice Options</h3>
          <div><p className="text-white text-sm mb-2">Number of dice</p><div className="grid grid-cols-2 gap-3">
            <button onClick={() => setOptions(o => ({...o, diceCount: 1}))} className={`py-2.5 rounded-xl text-sm font-medium transition-all ${options.diceCount === 1 ? 'bg-amber-500 text-white shadow-lg' : 'bg-white/10 text-white/60'}`}>🎲 1 Die</button>
            <button onClick={() => setOptions(o => ({...o, diceCount: 2}))} className={`py-2.5 rounded-xl text-sm font-medium transition-all ${options.diceCount === 2 ? 'bg-amber-500 text-white shadow-lg' : 'bg-white/10 text-white/60'}`}>🎲🎲 2 Dice</button>
          </div></div>
          {options.diceCount === 2 && <div><p className="text-white text-sm mb-2">Two dice mode</p><div className="grid grid-cols-2 gap-3">
            <button onClick={() => setOptions(o => ({...o, twoDiceMode: 'both'}))} className={`py-2.5 rounded-xl text-sm font-medium transition-all ${options.twoDiceMode === 'both' ? 'bg-amber-500 text-white shadow-lg' : 'bg-white/10 text-white/60'}`}>Use Both<div className="text-xs opacity-70 mt-0.5">Use each die separately</div></button>
            <button onClick={() => setOptions(o => ({...o, twoDiceMode: 'choose'}))} className={`py-2.5 rounded-xl text-sm font-medium transition-all ${options.twoDiceMode === 'choose' ? 'bg-amber-500 text-white shadow-lg' : 'bg-white/10 text-white/60'}`}>Choose One<div className="text-xs opacity-70 mt-0.5">Pick which die to use</div></button>
          </div></div>}
          <div className="bg-white/5 rounded-xl p-3 text-xs text-white/50 space-y-1">
            {options.diceCount === 1 ? (<><p>• Roll a <span className="text-amber-400 font-bold">6</span> to bring a piece out & get extra turn</p><p>• <span className="text-red-400 font-bold">3 consecutive 6s</span> reverses your turn!</p></>) : (<><p>• If <span className="text-amber-400 font-bold">any die shows 6</span>, use both dice values</p><p>• <span className="text-amber-400 font-bold">Double 6</span> gives extra turn</p><p>• <span className="text-red-400 font-bold">2 consecutive double 6s</span> reverses your turn!</p></>)}
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={onBack} className="flex-1 py-3 rounded-xl bg-white/10 text-white/70 font-medium hover:bg-white/20 transition-colors">← Back</button>
          <button onClick={() => onStart(options, playerCount)} className="flex-1 py-3 rounded-xl bg-gradient-to-r from-green-500 to-emerald-600 text-white font-bold shadow-lg hover:scale-105 transition-transform active:scale-95">Start Game →</button>
        </div>
      </div>
    </div>
  );
}

// ─── Online Login Screen ─────────────────────────────────────────────────────

function OnlineLoginScreen({ onConnect }: { onConnect: (socket: Socket, username: string, savedGames: SavedGameSummary[], positionStats: PositionStats | null) => void }) {
  const [serverUrl, setServerUrl] = useState(() => import.meta.env.VITE_SERVER_URL || 'https://ludo-app-local-plus-online.onrender.com/');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'create'>('login');
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);

  // Submitting through a real <form> lets the browser's password manager
  // detect the login and offer to save / autofill the credentials.
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleConnect();
  };

  const handleConnect = () => {
    if (!username.trim() || username.trim().length < 2) { setError('Username must be at least 2 characters'); return; }
    if (mode === 'create' && password.length < 4) { setError('Password must be at least 4 characters'); return; }
    if (mode === 'create' && password !== confirmPassword) { setError('Passwords do not match'); return; }
    setConnecting(true); setError('');
    const socket = io(serverUrl, { transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      socket.emit(mode === 'create' ? 'create-account' : 'login', { username: username.trim(), password });
    });

    socket.on('login-success', (data: { username: string; savedGames: SavedGameSummary[]; positionStats: PositionStats | null }) => {
      setConnecting(false);
      onConnect(socket, data.username, data.savedGames || [], data.positionStats ?? null);
    });

    socket.on('login-error', (data: { message: string; accountNotFound?: boolean }) => {
      setConnecting(false);
      setError(data.message);
      // If the server says the account doesn't exist, help the player by
      // switching them to the "Create Account" form.
      if (data.accountNotFound) setMode('create');
      socket.disconnect();
    });

    socket.on('connect_error', () => {
      setConnecting(false);
      setError('Could not connect to server. Make sure the server is running.');
      socket.disconnect();
    });

    setTimeout(() => {
      if (socket && !socket.connected) {
        setConnecting(false);
        setError('Connection timeout. Check server URL.');
        socket.disconnect();
      }
    }, 5000);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-blue-900 via-indigo-900 to-purple-900 p-4">
      <div className="text-center mb-8">
        <h1 className="text-5xl font-extrabold text-white mb-2">🌐 Online Play</h1>
        <p className="text-blue-200">Connect to a Ludo server</p>
      </div>
      <div className="bg-white/10 backdrop-blur-lg rounded-3xl p-6 shadow-2xl border border-white/20 max-w-sm w-full">
        {/* A real form (with autocomplete attributes) so the browser password
            manager offers to save and autofill these credentials. Pressing
            Enter in any field submits it. */}
        <form onSubmit={handleSubmit} method="post" action="#" className="space-y-4">
          <div className="grid grid-cols-2 gap-2 p-1 bg-white/10 rounded-xl">
            <button type="button" onClick={() => setMode('login')} className={`py-2 rounded-lg text-sm font-medium ${mode === 'login' ? 'bg-blue-500 text-white' : 'text-white/60'}`}>Login</button>
            <button type="button" onClick={() => setMode('create')} className={`py-2 rounded-lg text-sm font-medium ${mode === 'create' ? 'bg-green-500 text-white' : 'text-white/60'}`}>Create Account</button>
          </div>
          <div>
            <label htmlFor="ludo-server-url" className="text-white/70 text-sm mb-1 block">Server URL</label>
            <input id="ludo-server-url" name="serverUrl" type="text" autoComplete="url" value={serverUrl} onChange={e => setServerUrl(e.target.value)}
              className="w-full px-4 py-3 rounded-xl bg-white/10 border border-white/20 text-white placeholder-white/30 focus:outline-none focus:border-blue-400"
              placeholder="http://localhost:3001" />
          </div>
          <div>
            <label htmlFor="ludo-username" className="text-white/70 text-sm mb-1 block">Your Username</label>
            <input id="ludo-username" name="username" type="text" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)}
              className="w-full px-4 py-3 rounded-xl bg-white/10 border border-white/20 text-white placeholder-white/30 focus:outline-none focus:border-blue-400"
              placeholder="Enter your name" />
          </div>
          <div>
            <label htmlFor="ludo-password" className="text-white/70 text-sm mb-1 block">Password</label>
            <input id="ludo-password" name="password" type="password"
              autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
              value={password} onChange={e => setPassword(e.target.value)}
              className="w-full px-4 py-3 rounded-xl bg-white/10 border border-white/20 text-white placeholder-white/30 focus:outline-none focus:border-blue-400"
              placeholder="Enter password" />
          </div>
          {mode === 'create' && (
            <div>
              <label htmlFor="ludo-confirm-password" className="text-white/70 text-sm mb-1 block">Confirm Password</label>
              <input id="ludo-confirm-password" name="confirmPassword" type="password" autoComplete="new-password"
                value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-white/10 border border-white/20 text-white placeholder-white/30 focus:outline-none focus:border-blue-400"
                placeholder="Confirm password" />
            </div>
          )}
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          <button type="submit" disabled={connecting}
            className="w-full py-3 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-bold shadow-lg hover:scale-105 transition-transform active:scale-95 disabled:opacity-50">
            {connecting ? 'Connecting...' : mode === 'create' ? 'Create Account & Join' : 'Connect & Login'}
          </button>
        </form>
        <div className="mt-4 text-center">
          <p className="text-white/30 text-xs">For production, enter your Render backend URL, for example: https://your-app.onrender.com</p>
          <p className="text-white/30 text-xs mt-1">Local dev: <code className="bg-white/10 px-1.5 py-0.5 rounded">cd server && npm start</code></p>
        </div>
      </div>
    </div>
  );
}

// ─── Online Lobby Screen ─────────────────────────────────────────────────────

function OnlineLobbyScreen({ socket, username, onlineUsers, roomInfo, invites, savedGames, positionStats, voice, onBack, onResumeGame }: {
  socket: Socket; username: string; onlineUsers: string[]; roomInfo: RoomInfo | null;
  invites: InviteInfo[]; savedGames: SavedGameSummary[]; positionStats: PositionStats | null;
  voice: VoiceChatApi;
  onBack: () => void; onResumeGame: (gameId: string) => void;
}) {
  const [playerCount, setPlayerCount] = useState(4);
  const [options, setOptions] = useState<GameOptions>({ ...DEFAULT_OPTIONS, isAIMode: false });
  const [inviteUsername, setInviteUsername] = useState('');
  // Which previous position (colour) an invited replacement should take over.
  const [takeOverColor, setTakeOverColor] = useState<PlayerColor | ''>('');
  const [inviteError, setInviteError] = useState('');

  useEffect(() => {
    const onInviteError = (data: { message: string }) => setInviteError(data.message);
    socket.on('invite-error', onInviteError);
    return () => { socket.off('invite-error', onInviteError); };
  }, [socket]);

  // Vacant positions left behind by players who left mid-game.
  const vacantSlots = roomInfo?.vacantSlots ?? [];
  const pendingReplacements = roomInfo?.pendingReplacements ?? {};
  const promisedColors = new Set(Object.values(pendingReplacements));
  const assignableSlots = vacantSlots.filter(slot => !promisedColors.has(slot.color));

  // Keep the selected take-over colour valid as slots get filled.
  useEffect(() => {
    if (takeOverColor && !assignableSlots.some(slot => slot.color === takeOverColor)) setTakeOverColor('');
    if (!takeOverColor && assignableSlots.length > 0) setTakeOverColor(assignableSlots[0].color);
  }, [roomInfo]); // eslint-disable-line react-hooks/exhaustive-deps

  const createRoom = () => {
    socket.emit('create-room', { playerCount, options });
  };

  const sendInvite = (username: string) => {
    if (!username.trim() || !roomInfo) return;
    setInviteError('');
    // For an in-progress game the host must say which position the
    // replacement takes over, otherwise the game cannot resume.
    const color = assignableSlots.length > 0
      ? (takeOverColor || assignableSlots[0].color)
      : undefined;
    socket.emit('invite-player', { roomId: roomInfo.id, username: username.trim(), takeOverColor: color });
  };

  const invitePlayer = () => {
    if (!inviteUsername.trim() || !roomInfo) return;
    sendInvite(inviteUsername);
    setInviteUsername('');
  };

  const acceptInvite = (roomId: string) => {
    socket.emit('accept-invite', { roomId });
  };

  const rejectInvite = (roomId: string) => {
    socket.emit('reject-invite', { roomId });
  };

  const startGame = () => {
    if (!roomInfo) return;
    socket.emit('start-game', { roomId: roomInfo.id });
  };

  const leaveRoom = () => {
    if (!roomInfo) return;
    socket.emit('leave-room', { roomId: roomInfo.id });
  };

  const isHost = roomInfo?.host === username;

  return (
    <div className="flex flex-col items-center min-h-screen bg-gradient-to-br from-slate-800 via-slate-900 to-slate-800 p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <button onClick={onBack} className="text-white/60 hover:text-white text-sm">← Disconnect</button>
          <div className="text-white font-bold">🌐 {username}</div>
        </div>

        {/* Player Position Stats — always shown so players can see their record */}
        {(() => {
          const stats = positionStats ?? emptyPositionStats();
          return (
            <div className="bg-gradient-to-br from-amber-500/15 to-yellow-500/10 border border-amber-500/30 rounded-2xl p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-amber-300 font-semibold text-sm">🏆 Position Record</h3>
                <span className="text-amber-200/60 text-xs">{stats.gamesPlayed || 0} games</span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <div className="flex flex-col items-center justify-center rounded-xl bg-yellow-500/20 border border-yellow-500/40 p-2">
                  <span className="text-lg">🥇</span>
                  <span className="text-yellow-200 text-xs font-medium">1st</span>
                  <span className="text-white text-lg font-bold leading-none mt-0.5">{stats.first}</span>
                </div>
                <div className="flex flex-col items-center justify-center rounded-xl bg-slate-300/20 border border-slate-300/40 p-2">
                  <span className="text-lg">🥈</span>
                  <span className="text-slate-200 text-xs font-medium">2nd</span>
                  <span className="text-white text-lg font-bold leading-none mt-0.5">{stats.second}</span>
                </div>
                <div className="flex flex-col items-center justify-center rounded-xl bg-orange-700/20 border border-orange-600/40 p-2">
                  <span className="text-lg">🥉</span>
                  <span className="text-orange-200 text-xs font-medium">3rd</span>
                  <span className="text-white text-lg font-bold leading-none mt-0.5">{stats.third}</span>
                </div>
                <div className="flex flex-col items-center justify-center rounded-xl bg-white/5 border border-white/15 p-2">
                  <span className="text-lg">4️⃣</span>
                  <span className="text-white/70 text-xs font-medium">4th</span>
                  <span className="text-white text-lg font-bold leading-none mt-0.5">{stats.fourth}</span>
                </div>
              </div>
              <p className="text-amber-200/50 text-[11px] mt-2 text-center">Game ends when the second-last player finishes, so all players are ranked.</p>
            </div>
          );
        })()}

        {/* Invites */}
        {invites.length > 0 && (
          <div className="bg-amber-500/20 border border-amber-500/40 rounded-2xl p-4 mb-4">
            <h3 className="text-amber-400 font-semibold text-sm mb-2">📨 Game Invites</h3>
            {invites.map(inv => (
              <div key={inv.roomId} className="flex items-center justify-between py-2 border-b border-white/10 last:border-0">
                <div><span className="text-white text-sm">{inv.from}</span><span className="text-white/40 text-xs ml-2">({inv.playerCount} players)</span></div>
                <div className="flex gap-2">
                  <button onClick={() => acceptInvite(inv.roomId)} className="px-3 py-1 bg-green-500 text-white text-xs rounded-lg font-medium">Accept</button>
                  <button onClick={() => rejectInvite(inv.roomId)} className="px-3 py-1 bg-red-500/50 text-white text-xs rounded-lg font-medium">Reject</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Current Room */}
        {roomInfo && (
          <div className="bg-white/5 border border-white/20 rounded-2xl p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-semibold text-sm">🏠 Room: {roomInfo.id}</h3>
              <button onClick={leaveRoom} className="text-red-400 text-xs hover:text-red-300">Leave</button>
            </div>
            <div className="space-y-2">
              {roomInfo.players.map(p => (
                <div key={p} className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full border" style={{ backgroundColor: PLAYER_COLORS[roomInfo.playerColors[p]].bg, borderColor: PLAYER_COLORS[roomInfo.playerColors[p]].dark }} />
                  <span className="text-white text-sm">{p}</span>
                  {p === roomInfo.host && <span className="text-amber-400 text-xs">👑 Host</span>}
                  {p === username && <span className="text-white/40 text-xs">(you)</span>}
                </div>
              ))}
              {Array.from({ length: roomInfo.playerCount - roomInfo.players.length }, (_, i) => (
                <div key={`empty-${i}`} className="flex items-center gap-2 opacity-30">
                  <div className="w-5 h-5 rounded-full border border-white/30" />
                  <span className="text-white text-sm">Waiting...</span>
                </div>
              ))}
            </div>
            {/* Replacement take-over: the host picks which vacated position the
                invited player will control so the game can resume. */}
            {isHost && assignableSlots.length > 0 && (
              <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
                <p className="text-amber-300 text-xs font-semibold mb-2">Replacement takes over position</p>
                <div className="grid grid-cols-2 gap-2">
                  {assignableSlots.map(slot => (
                    <button key={slot.color} type="button" onClick={() => setTakeOverColor(slot.color)}
                      className={`flex items-center gap-2 rounded-lg px-2 py-2 text-xs font-medium transition-colors ${takeOverColor === slot.color ? 'bg-amber-500 text-white' : 'bg-white/10 text-white/70'}`}>
                      <span className="w-3.5 h-3.5 rounded-full border" style={{ backgroundColor: PLAYER_COLORS[slot.color].bg, borderColor: PLAYER_COLORS[slot.color].dark }} />
                      {capitalize(slot.color)} <span className="opacity-60">({slot.username})</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {isHost && Object.keys(pendingReplacements).length > 0 && (
              <div className="mt-2 space-y-1">
                {Object.entries(pendingReplacements).map(([uname, color]) => (
                  <p key={uname} className="text-white/40 text-xs">⏳ {uname} invited to take over {capitalize(color)}</p>
                ))}
              </div>
            )}
            {/* Enter in the invite box sends the invite. */}
            <form onSubmit={e => { e.preventDefault(); invitePlayer(); }} className="mt-3 flex gap-2">
              <input type="text" name="inviteUsername" autoComplete="off" value={inviteUsername} onChange={e => setInviteUsername(e.target.value)} placeholder="Enter username to invite"
                className="flex-1 px-3 py-2 rounded-lg bg-white/10 border border-white/20 text-white text-sm placeholder-white/30 focus:outline-none focus:border-blue-400" />
              <button type="submit" disabled={!isHost || !inviteUsername.trim()} className="px-4 py-2 bg-blue-500 text-white text-sm rounded-lg font-medium disabled:opacity-30">Invite</button>
            </form>
            {inviteError && <p className="text-red-400 text-xs mt-2">{inviteError}</p>}
            {!isHost && <p className="text-white/30 text-xs mt-2">Only the host can invite and start</p>}
            {isHost && roomInfo.players.length >= roomInfo.playerCount && (
              <button onClick={startGame} className="w-full mt-3 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-bold rounded-xl shadow-lg hover:scale-105 transition-transform active:scale-95">
                🎮 Start Game!
              </button>
            )}
            <VoicePanel voice={voice} me={username} />
          </div>
        )}

        {/* Create Room (only when not in a room) */}
        {!roomInfo && (
          <div className="bg-white/5 border border-white/20 rounded-2xl p-4 mb-4">
            <h3 className="text-white font-semibold text-sm mb-3">🎮 Create a Room</h3>
            <div className="space-y-3">
              <div><p className="text-white/60 text-xs mb-1">Players</p>
                <div className="flex gap-2">
                  {[2,3,4].map(n => (
                    <button key={n} onClick={() => setPlayerCount(n)} className={`flex-1 py-2 rounded-lg text-sm font-medium ${playerCount === n ? 'bg-blue-500 text-white' : 'bg-white/10 text-white/60'}`}>{n}P</button>
                  ))}
                </div>
              </div>
              <div className="flex gap-3 text-xs">
                <label className="flex items-center gap-1 text-white/60"><input type="checkbox" checked={options.extraRollOnEntry} onChange={e => setOptions(o => ({...o, extraRollOnEntry: e.target.checked}))} /> Entry bonus</label>
                <label className="flex items-center gap-1 text-white/60"><input type="checkbox" checked={options.extraTurnOnCapture} onChange={e => setOptions(o => ({...o, extraTurnOnCapture: e.target.checked}))} /> Capture bonus</label>
              </div>
              <div>
                <p className="text-white/60 text-xs mb-1">Dice</p>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => setOptions(o => ({ ...o, diceCount: 1 }))} className={`py-2 rounded-lg text-sm font-medium ${options.diceCount === 1 ? 'bg-amber-500 text-white' : 'bg-white/10 text-white/60'}`}>1 Die</button>
                  <button onClick={() => setOptions(o => ({ ...o, diceCount: 2 }))} className={`py-2 rounded-lg text-sm font-medium ${options.diceCount === 2 ? 'bg-amber-500 text-white' : 'bg-white/10 text-white/60'}`}>2 Dice</button>
                </div>
                {options.diceCount === 2 && (
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <button onClick={() => setOptions(o => ({ ...o, twoDiceMode: 'both' }))} className={`py-2 rounded-lg text-xs font-medium ${options.twoDiceMode === 'both' ? 'bg-amber-500 text-white' : 'bg-white/10 text-white/60'}`}>Use Both</button>
                    <button onClick={() => setOptions(o => ({ ...o, twoDiceMode: 'choose' }))} className={`py-2 rounded-lg text-xs font-medium ${options.twoDiceMode === 'choose' ? 'bg-amber-500 text-white' : 'bg-white/10 text-white/60'}`}>Choose One</button>
                  </div>
                )}
              </div>
              <button onClick={createRoom} className="w-full py-3 bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-bold rounded-xl shadow-lg hover:scale-105 transition-transform active:scale-95">
                Create Room
              </button>
            </div>
          </div>
        )}

        {savedGames.length > 0 && (
          <div className="bg-white/5 border border-white/20 rounded-2xl p-4 mb-4">
            <h3 className="text-white font-semibold text-sm mb-3">🔁 Resume Saved Games</h3>
            <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
              {savedGames.map(game => (
                <button key={game.gameId} onClick={() => onResumeGame(game.gameId)} className="w-full text-left px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20 transition-colors">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-white text-sm font-medium">{game.title}</span>
                    <span className="text-white/40 text-xs">{new Date(game.updatedAt).toLocaleDateString()}</span>
                  </div>
                  <div className="text-white/40 text-xs mt-1">Game ID: {game.gameId}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Online Users */}
        <div className="bg-white/5 border border-white/20 rounded-2xl p-4">
          <h3 className="text-white font-semibold text-sm mb-3">👥 Online Users ({onlineUsers.length})</h3>
          {onlineUsers.length === 0 ? (
            <p className="text-white/30 text-sm">No other users online</p>
          ) : (
            <div className="space-y-1">
              {onlineUsers.filter(u => u !== username).map(u => (
                <div key={u} className="flex items-center justify-between py-1.5">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green-400" />
                    <span className="text-white text-sm">{u}</span>
                  </div>
                  {roomInfo && isHost && !roomInfo.players.includes(u) && (roomInfo.players.length < roomInfo.playerCount || assignableSlots.length > 0) && (
                    <button onClick={() => sendInvite(u)} className="px-3 py-1 bg-blue-500/50 text-white text-xs rounded-lg">
                      {assignableSlots.length > 0 ? `Invite as ${capitalize(takeOverColor || assignableSlots[0].color)}` : 'Invite'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Admin Portal ──────────────────────────────────────────────────────────

function AdminPortal({
  open,
  onClose,
  onRefreshLocal,
}: {
  open: boolean;
  onClose: () => void;
  onRefreshLocal: () => void;
}) {
  const [serverUrl, setServerUrl] = useState(() => getDefaultServerUrl());
  const [adminKey, setAdminKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [adminData, setAdminData] = useState<AdminDataPayload>({ accounts: [], savedGames: [] });
  const [status, setStatus] = useState('');
  const [localSavedGames, setLocalSavedGames] = useState<SavedGameSummary[]>([]);

  useEffect(() => {
    if (!open) return;
    setLocalSavedGames(loadLocalSavedGames());
  }, [open]);

  useEffect(() => {
    if (!socket) return;

    const onAdminData = (data: AdminDataPayload) => setAdminData(data);
    const onAdminAuthError = (data: { message: string }) => {
      setConnecting(false);
      setStatus(data.message);
      socket.disconnect();
      setSocket(null);
    };
    const onAdminAuthSuccess = () => {
      setConnecting(false);
      setStatus('Admin access granted');
    };

    socket.on('admin-data', onAdminData);
    socket.on('admin-auth-error', onAdminAuthError);
    socket.on('admin-auth-success', onAdminAuthSuccess);

    return () => {
      socket.off('admin-data', onAdminData);
      socket.off('admin-auth-error', onAdminAuthError);
      socket.off('admin-auth-success', onAdminAuthSuccess);
    };
  }, [socket]);

  useEffect(() => {
    if (!open && socket) {
      socket.disconnect();
      setSocket(null);
    }
  }, [open, socket]);

  const connectAdmin = () => {
    if (!adminKey.trim()) {
      setStatus('Admin key required');
      return;
    }
    setConnecting(true);
    setStatus('Connecting...');
    const adminSocket = io(serverUrl, { transports: ['websocket', 'polling'] });

    adminSocket.on('connect', () => {
      adminSocket.emit('admin-auth', { secret: adminKey.trim() });
    });

    adminSocket.on('connect_error', () => {
      setConnecting(false);
      setStatus('Could not connect to server');
      adminSocket.disconnect();
    });

    setSocket(adminSocket);
  };

  const refresh = () => {
    socket?.emit('admin-refresh');
    setLocalSavedGames(loadLocalSavedGames());
    onRefreshLocal();
  };

  const deleteAccount = (username: string) => {
    socket?.emit('admin-delete-account', { username });
  };

  const deleteServerGame = (gameId: string) => {
    socket?.emit('admin-delete-saved-game', { gameId });
  };

  const deleteLocalGame = (gameId: string) => {
    removeLocalGameSnapshot(gameId);
    setLocalSavedGames(loadLocalSavedGames());
    onRefreshLocal();
  };

  return (
    <div className={`fixed inset-0 z-[100] ${open ? 'flex' : 'hidden'} items-center justify-center bg-black/80 p-4`}>
      <div className="w-full max-w-5xl max-h-[92vh] overflow-hidden rounded-3xl border border-white/20 bg-slate-950 text-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <h2 className="text-xl font-bold">Admin Portal</h2>
            <p className="text-xs text-white/40">Hidden access panel</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={refresh} className="rounded-xl bg-white/10 px-3 py-2 text-sm text-white/80 hover:bg-white/20">Refresh</button>
            <button onClick={onClose} className="rounded-xl bg-red-500/80 px-3 py-2 text-sm font-semibold text-white hover:bg-red-500">Close</button>
          </div>
        </div>

        <div className="grid gap-4 p-5 md:grid-cols-[320px_1fr]">
          <div className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <h3 className="mb-3 text-sm font-semibold text-white">Admin Access</h3>
              {/* Real form so Enter submits and the password manager can help. */}
              <form onSubmit={e => { e.preventDefault(); connectAdmin(); }} method="post" action="#" className="space-y-3">
                <div>
                  <label htmlFor="ludo-admin-server-url" className="mb-1 block text-xs text-white/50">Server URL</label>
                  <input id="ludo-admin-server-url" name="adminServerUrl" type="text" autoComplete="url" value={serverUrl} onChange={e => setServerUrl(e.target.value)} className="w-full rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm text-white outline-none" />
                </div>
                <div>
                  <label htmlFor="ludo-admin-key" className="mb-1 block text-xs text-white/50">Admin Key</label>
                  <input id="ludo-admin-key" name="adminKey" type="password" autoComplete="current-password" value={adminKey} onChange={e => setAdminKey(e.target.value)} className="w-full rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm text-white outline-none" />
                </div>
                <button type="submit" disabled={connecting} className="w-full rounded-xl bg-indigo-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
                  {connecting ? 'Connecting...' : 'Unlock Admin'}
                </button>
                <p className="text-xs text-amber-300/80">Shortcut: {ADMIN_SHORTCUT}</p>
                {status && <p className="text-xs text-white/60">{status}</p>}
              </form>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white">Local Saved Games</h3>
                <span className="text-xs text-white/40">{localSavedGames.length}</span>
              </div>
              <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                {localSavedGames.length === 0 ? (
                  <p className="text-sm text-white/40">No local saves</p>
                ) : localSavedGames.map(game => (
                  <div key={game.gameId} className="rounded-xl border border-white/10 bg-black/20 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">{game.title}</p>
                        <p className="text-[11px] text-white/40">{game.gameId}</p>
                      </div>
                      <button onClick={() => deleteLocalGame(game.gameId)} className="rounded-lg bg-red-500/70 px-2 py-1 text-[11px] font-semibold">Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white">Accounts</h3>
                <span className="text-xs text-white/40">{adminData.accounts.length}</span>
              </div>
              <div className="max-h-[34rem] space-y-2 overflow-y-auto pr-1">
                {adminData.accounts.length === 0 ? (
                  <p className="text-sm text-white/40">Unlock admin to view accounts.</p>
                ) : adminData.accounts.map(account => (
                  <div key={account.username} className="rounded-xl border border-white/10 bg-black/20 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">{account.username}</p>
                        <p className="text-[11px] text-white/40">Created: {new Date(account.createdAt).toLocaleString()}</p>
                        <p className="text-[11px] text-white/40">Last login: {new Date(account.lastLogin).toLocaleString()}</p>
                      </div>
                      <button onClick={() => deleteAccount(account.username)} className="rounded-lg bg-red-500/70 px-2 py-1 text-[11px] font-semibold">Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white">Saved Online Games</h3>
                <span className="text-xs text-white/40">{adminData.savedGames.length}</span>
              </div>
              <div className="max-h-[34rem] space-y-2 overflow-y-auto pr-1">
                {adminData.savedGames.length === 0 ? (
                  <p className="text-sm text-white/40">No saved online games found.</p>
                ) : adminData.savedGames.map(game => (
                  <div key={game.gameId} className="rounded-xl border border-white/10 bg-black/20 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">{game.title}</p>
                        <p className="text-[11px] text-white/40">Host: {game.host}</p>
                        <p className="text-[11px] text-white/40">Participants: {game.participants.join(', ') || 'none'}</p>
                        <p className="text-[11px] text-white/40">Updated: {new Date(game.updatedAt).toLocaleString()}</p>
                      </div>
                      <button onClick={() => deleteServerGame(game.gameId)} className="rounded-lg bg-red-500/70 px-2 py-1 text-[11px] font-semibold">Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Score Board ─────────────────────────────────────────────────────────────

function ScoreBoard({ state, myColor }: { state: GameState; myColor?: PlayerColor | null }) {
  const finishedOrder = state.finishedOrder || [];
  return (
    <div className="flex gap-2 flex-wrap justify-center">
      {state.players.map(player => {
        const colors = PLAYER_COLORS[player];
        const finished = state.tokens.filter(t => t.player === player && t.steps >= 56).length;
        const captured = state.captureCounts[player] ?? 0;
        const isCurrent = getCurrentPlayer(state) === player;
        const isMe = myColor === player;
        const placeIdx = finishedOrder.indexOf(player);
        const placeLabel = placeIdx >= 0 ? (['1st', '2nd', '3rd', '4th'][placeIdx] ?? '') : '';
        return (
          <div key={player} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-xl border-2 transition-all duration-300 ${isCurrent ? 'scale-110 shadow-lg' : 'opacity-60'}`}
            style={{ backgroundColor: colors.light, borderColor: isCurrent ? colors.dark : colors.border }}>
            <div className="w-3.5 h-3.5 rounded-full border" style={{ backgroundColor: colors.bg, borderColor: colors.dark }} />
            <span className="text-xs font-bold" style={{ color: colors.text }}>{capitalize(player)}</span>
            <span className="text-xs font-medium" style={{ color: colors.dark }}>{finished}/4</span>
            <span className="text-xs font-medium" style={{ color: colors.dark }}>C:{captured}</span>
            {placeLabel && <span className="text-xs font-bold" style={{ color: colors.dark }}>🏁{placeLabel}</span>}
            {isMe && <span className="text-xs" style={{ color: colors.dark }}>⭐</span>}
          </div>
        );
      })}
    </div>
  );
}

// ─── Game Board Component ────────────────────────────────────────────────────

function GameBoard({ gameState, boardSize, myColor, isOnline, isRolling, onTokenClick, onRollDice, onSelectDice, onNewGame, onPlayAgain }: {
  gameState: GameState; boardSize: number; myColor?: PlayerColor | null;
  isOnline: boolean; isRolling: boolean;
  onTokenClick: (token: Token) => void; onRollDice: () => void;
  onSelectDice: (index: number) => void; onNewGame: () => void; onPlayAgain: () => void;
}) {
  const currentPlayer = getCurrentPlayer(gameState);
  const isMyTurn = isOnline ? myColor === currentPlayer : isHumanTurn(gameState);
  const isHuman = isOnline ? isMyTurn : isHumanTurn(gameState);

  const activeDiceValue = gameState.selectedDiceIndex !== null ? gameState.pendingDice[gameState.selectedDiceIndex] : null;
  const validMoves = gameState.diceRolled && gameState.pendingDice.length > 0 && isHuman
    ? activeDiceValue !== null ? getValidMoves(gameState.tokens, currentPlayer, activeDiceValue, gameState.captureCounts) : getValidMovesForAnyDice(gameState.tokens, currentPlayer, gameState.pendingDice, gameState.captureCounts)
    : [];
  const validTokenIds = new Set(validMoves.map(t => `${t.player}-${t.id}`));

  const tokenPositionMap = new Map<string, Token[]>();
  gameState.tokens.forEach(token => {
    if (token.steps >= 56) return;
    const [r, c] = getTokenPosition(token);
    const key = `${r},${c}`;
    if (!tokenPositionMap.has(key)) tokenPositionMap.set(key, []);
    tokenPositionMap.get(key)!.push(token);
  });

  const cellSize = boardSize / 15;

  const usedDiceIndices = new Set<number>();
  if (gameState.diceRolled && gameState.diceValues.length > 0) {
    const pendingCopy = [...gameState.pendingDice];
    for (let i = 0; i < gameState.diceValues.length; i++) {
      const pIdx = pendingCopy.indexOf(gameState.diceValues[i]);
      if (pIdx !== -1) pendingCopy.splice(pIdx, 1); else usedDiceIndices.add(i);
    }
  }

  const sixesWarning = gameState.options.diceCount === 1
    ? gameState.consecutiveSixes >= 2 ? '⚠️ One more 6 will reverse your turn!' : ''
    : gameState.consecutiveSixes >= 1 ? '⚠️ One more double 6 will reverse your turn!' : '';

  return (
    <div className="flex flex-col items-center min-h-screen bg-gradient-to-br from-slate-800 via-slate-900 to-slate-800 overflow-hidden">
      <div className="w-full bg-black/30 backdrop-blur-sm py-2 px-4 flex items-center justify-between border-b border-white/10">
        <h1 className="text-lg font-bold text-white tracking-wide">🎲 LUDO{isOnline ? ' 🌐' : ''}</h1>
        <button onClick={onNewGame} className="text-xs px-3 py-1 rounded-lg bg-white/10 text-white/70 hover:bg-white/20 hover:text-white transition-colors">
          {isOnline ? 'Leave' : 'New Game'}
        </button>
      </div>

      <div className="py-2"><ScoreBoard state={gameState} myColor={myColor} /></div>

      <div className="py-1 text-center px-4">
        <p className="text-sm font-semibold px-4 py-1.5 rounded-full inline-block" style={{ backgroundColor: PLAYER_COLORS[currentPlayer].light, color: PLAYER_COLORS[currentPlayer].dark }}>
          {gameState.message}
        </p>
        {gameState.consecutiveSixes > 0 && !gameState.winner && (
          <div className="flex items-center justify-center gap-1 mt-1">
            {gameState.options.diceCount === 1
              ? [1,2,3].map(n => <span key={n} className={`inline-block w-2 h-2 rounded-full ${n <= gameState.consecutiveSixes ? 'bg-amber-400' : 'bg-white/20'}`} />)
              : [1,2].map(n => <span key={n} className={`inline-block w-3 h-3 rounded-full text-xs flex items-center justify-center ${n <= gameState.consecutiveSixes ? 'bg-amber-400 text-amber-900' : 'bg-white/20 text-white/30'}`}>6</span>)
            }
          </div>
        )}
        {sixesWarning && !gameState.winner && <p className="text-xs text-red-400 mt-0.5 animate-pulse">{sixesWarning}</p>}
      </div>

      <div className="flex items-center justify-center p-2">
        <div className="grid border-2 border-amber-800 rounded-lg shadow-2xl overflow-hidden" style={{ gridTemplateColumns: `repeat(15,${cellSize}px)`, gridTemplateRows: `repeat(15,${cellSize}px)`, backgroundColor: '#f5f0e1' }}>
          {Array.from({ length: 15 }, (_, r) => Array.from({ length: 15 }, (_, c) => {
            const key = `${r},${c}`;
            const tc = tokenPositionMap.get(key) || [];
            return <BoardCell key={key} r={r} c={c} cellSize={cellSize} tokensOnCell={tc} validTokenIds={validTokenIds} onTokenClick={onTokenClick} />;
          }))}
        </div>
      </div>

      <div className="w-full max-w-md mx-auto px-4 pb-4 pt-2">
        <div className="flex items-center justify-center gap-4">
          <div className="flex flex-col items-center gap-2">
            <div className="flex gap-2">
              {gameState.diceValues.length > 0 ? gameState.diceValues.map((dv, i) => {
                const isUsed = usedDiceIndices.has(i);
                const isSelected = gameState.selectedDiceIndex !== null && gameState.pendingDice[gameState.selectedDiceIndex] === dv && !isUsed;
                const canSelect = gameState.diceRolled && !isUsed && isHuman && gameState.pendingDice.length > 1;
                return <DiceFace key={i} value={dv} rolling={isRolling} selected={isSelected} used={isUsed} onClick={canSelect ? () => { const pIdx = gameState.pendingDice.indexOf(dv); if (pIdx !== -1) onSelectDice(pIdx); } : undefined} />;
              }) : Array.from({ length: gameState.options.diceCount }, (_, i) => <DiceFace key={i} value={null} rolling={isRolling && i === 0} />)}
            </div>
            {isHuman && !gameState.winner && (
              <div className="flex flex-col items-center gap-1">
                <button onClick={onRollDice} disabled={gameState.diceRolled || isRolling}
                  className={`px-6 py-2.5 rounded-xl font-bold text-sm shadow-lg transition-all ${gameState.diceRolled || isRolling ? 'bg-gray-600 text-gray-400 cursor-not-allowed' : 'bg-gradient-to-r from-yellow-400 to-orange-500 text-white hover:scale-105 active:scale-95'}`}>
                  {isRolling ? 'Rolling...' : gameState.diceRolled ? 'Tap a Token' : gameState.pendingExtraRoll ? 'Roll again 🎲' : 'Roll Dice 🎲'}
                </button>
                <p className="text-[11px] text-white/50">Shortcut: R or Space</p>
              </div>
            )}
            {!isHuman && !gameState.winner && (
              <div className="px-6 py-2.5 rounded-xl bg-white/10 text-white/50 text-sm font-medium">{isOnline ? 'Waiting for player...' : 'AI thinking...'}</div>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            {gameState.players.map(p => {
              const f = gameState.tokens.filter(t => t.player === p && t.steps >= 56).length;
              if (f === 0) return null;
              return <div key={p} className="flex items-center gap-1.5"><div className="w-4 h-4 rounded-full border-2" style={{ backgroundColor: PLAYER_COLORS[p].bg, borderColor: PLAYER_COLORS[p].dark }} /><span className="text-white text-xs font-bold">{f}/4 ✓</span></div>;
            })}
          </div>
        </div>
        {gameState.winner && (() => {
          const finishedOrder = gameState.finishedOrder || [];
          const remaining = gameState.players.filter(p => !finishedOrder.includes(p));
          const ranking = [...finishedOrder, ...remaining];
          const placeLabels = ['1st', '2nd', '3rd', '4th'];
          const placeEmojis = ['🥇', '🥈', '🥉', '4️⃣'];
          return (
            <div className="mt-4 text-center">
              <div className="inline-block px-8 py-4 rounded-2xl font-bold text-xl text-white shadow-xl animate-bounce" style={{ backgroundColor: PLAYER_COLORS[gameState.winner].bg }}>🏆 {capitalize(gameState.winner)} wins! 🏆</div>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                {ranking.map((p, i) => (
                  <div key={p} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border-2" style={{ backgroundColor: PLAYER_COLORS[p].light, borderColor: PLAYER_COLORS[p].dark }}>
                    <span className="text-base">{placeEmojis[i]}</span>
                    <span className="text-sm font-bold" style={{ color: PLAYER_COLORS[p].text }}>{placeLabels[i]}</span>
                    <span className="text-sm font-semibold text-white/90" style={{ color: PLAYER_COLORS[p].dark }}>{capitalize(p)}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-center gap-3">
                {!isOnline && (
                  <button onClick={onPlayAgain} className="px-6 py-2 bg-white/20 text-white rounded-xl font-medium hover:bg-white/30 transition-colors">🔁 Play Again</button>
                )}
                <button onClick={onNewGame} className="px-6 py-2 bg-gradient-to-r from-blue-500 to-indigo-600 text-white rounded-xl font-bold hover:scale-105 transition-transform active:scale-95">🏠 Home</button>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────

export default function App() {
  const [screen, setScreen] = useState<Screen>('start');
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [isRolling, setIsRolling] = useState(false);
  const [boardSize, setBoardSize] = useState(0);
  const [localSavedGames, setLocalSavedGames] = useState<SavedGameSummary[]>(() => loadLocalSavedGames());
  const [adminPortalOpen, setAdminPortalOpen] = useState(false);

  // Online state
  const [socket, setSocket] = useState<Socket | null>(null);
  const [onlineUsername, setOnlineUsername] = useState('');
  const [onlineUsers, setOnlineUsers] = useState<string[]>([]);
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [invites, setInvites] = useState<InviteInfo[]>([]);
  const [myColor, setMyColor] = useState<PlayerColor | null>(null);
  const [onlineGameState, setOnlineGameState] = useState<GameState | null>(null);
  const [onlineSavedGames, setOnlineSavedGames] = useState<SavedGameSummary[]>([]);
  const [positionStats, setPositionStats] = useState<PositionStats | null>(null);

  // Voice chat (WebRTC mesh, Socket.IO signaling) — only for online rooms.
  const voice = useVoiceChat({
    socket,
    roomId: roomInfo?.id ?? null,
    username: onlineUsername,
  });

  // When an online game ends the room is torn down server-side; leave voice.
  useEffect(() => {
    if (onlineGameState?.winner) voice.leave();
  }, [onlineGameState?.winner, voice.leave]);

  // Local game refs
  const stateRef = useRef<GameState | null>(null);
  const rollingRef = useRef(false);

  useEffect(() => { stateRef.current = gameState; }, [gameState]);
  useEffect(() => { rollingRef.current = isRolling; }, [isRolling]);

  useEffect(() => {
    function updateSize() {
      const maxSize = Math.min(window.innerWidth * 0.96, window.innerHeight * 0.58, 540);
      setBoardSize(Math.floor(maxSize / 15) * 15);
    }
    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.altKey && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setAdminPortalOpen(true);
      }
      if (event.key === 'Escape') {
        setAdminPortalOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ─── Socket Event Listeners ─────────────────────────────────────────────

  useEffect(() => {
    if (!socket) return;

    const onOnlineUsers = (data: { users: string[] }) => setOnlineUsers(data.users);
    const onRoomCreated = (data: { roomId: string; room: RoomInfo }) => { setRoomInfo(data.room); setInvites([]); };
    const onRoomUpdated = (data: { roomId: string; room: RoomInfo }) => setRoomInfo(data.room);
    const onRoomInvite = (data: InviteInfo) => setInvites(prev => [...prev.filter(i => i.roomId !== data.roomId), data]);
    const onInviteRejected = (_data: { username: string }) => { /* could show toast */ };
    const onYourColor = (data: { color: PlayerColor }) => setMyColor(data.color);
    const onPlayerDisconnected = (_data: { username: string }) => { /* could show toast */ };
    const onSavedGamesUpdated = (data: { savedGames: SavedGameSummary[] }) => setOnlineSavedGames(data.savedGames || []);
    const onPositionStats = (data: { positionStats: PositionStats }) => setPositionStats(data.positionStats || emptyPositionStats());

    const onGameStarted = (data: { roomId: string; gameState: GameState; playerColors: Record<string, PlayerColor>; room: RoomInfo }) => {
      setOnlineGameState(normalizeGameState(data.gameState));
      setRoomInfo(data.room);
      setScreen('game');
    };

    const onGameResumed = (data: { roomId: string; gameState: GameState; room: RoomInfo }) => {
      setOnlineGameState(normalizeGameState(data.gameState));
      setRoomInfo(data.room);
      setScreen('game');
    };

    const onGameState = (data: { gameState: GameState }) => {
      setOnlineGameState(normalizeGameState(data.gameState));
    };

    const onDiceRolled = (_data: { diceValues: number[] }) => {
      // Brief rolling animation
      setIsRolling(true);
      setTimeout(() => setIsRolling(false), 400);
    };

    socket.on('online-users', onOnlineUsers);
    socket.on('room-created', onRoomCreated);
    socket.on('room-updated', onRoomUpdated);
    socket.on('room-invite', onRoomInvite);
    socket.on('invite-rejected', onInviteRejected);
    socket.on('game-started', onGameStarted);
    socket.on('game-resumed', onGameResumed);
    socket.on('game-state', onGameState);
    socket.on('dice-rolled', onDiceRolled);
    socket.on('your-color', onYourColor);
    socket.on('player-disconnected', onPlayerDisconnected);
    socket.on('saved-games-updated', onSavedGamesUpdated);
    socket.on('position-stats', onPositionStats);

    return () => {
      socket.off('online-users', onOnlineUsers);
      socket.off('room-created', onRoomCreated);
      socket.off('room-updated', onRoomUpdated);
      socket.off('room-invite', onRoomInvite);
      socket.off('invite-rejected', onInviteRejected);
      socket.off('game-started', onGameStarted);
      socket.off('game-resumed', onGameResumed);
      socket.off('game-state', onGameState);
      socket.off('dice-rolled', onDiceRolled);
      socket.off('your-color', onYourColor);
      socket.off('player-disconnected', onPlayerDisconnected);
      socket.off('saved-games-updated', onSavedGamesUpdated);
      socket.off('position-stats', onPositionStats);
    };
  }, [socket]);

  useEffect(() => {
    if (screen === 'start' || screen === 'options') {
      setLocalSavedGames(loadLocalSavedGames());
    }
  }, [screen]);

  useEffect(() => {
    if (!gameState || screen !== 'game' || onlineGameState) return;
    if (gameState.winner) {
      removeLocalGameSnapshot(gameState.gameId);
      setLocalSavedGames(loadLocalSavedGames());
      return;
    }
    saveLocalGameSnapshot(gameState);
    setLocalSavedGames(loadLocalSavedGames());
  }, [gameState, screen, onlineGameState]);

  // ─── Local Game Logic (same as before) ─────────────────────────────────

  const transitionToNextPlayer = useCallback((prev: GameState, overrideIndex?: number): GameState => {
    // Find the next non-finished player. If the game already has a winner
    // (i.e. 3 players have finished) we keep currentPlayerIndex as-is.
    const finished = prev.finishedOrder || [];
    let npi = overrideIndex !== undefined ? overrideIndex : (prev.currentPlayerIndex + 1) % prev.players.length;
    if (prev.winner) {
      return { ...prev, diceRolled: false, diceValues: [], pendingDice: [], selectedDiceIndex: null, pendingExtraRoll: false, pendingBonusReason: '', missedCaptureTargets: [], capturedThisTurn: false, consecutiveSixes: 0, rollHasSix: false, isTransitioning: false };
    }
    if (finished.length > 0) {
      let safety = prev.players.length;
      while (safety-- > 0 && finished.includes(prev.players[npi])) {
        npi = (npi + 1) % prev.players.length;
      }
    }
    const np = prev.players[npi];
    return { ...prev, diceRolled: false, diceValues: [], pendingDice: [], selectedDiceIndex: null, currentPlayerIndex: npi, pendingExtraRoll: false, pendingBonusReason: '', missedCaptureTargets: [], capturedThisTurn: false, consecutiveSixes: 0, rollHasSix: false, message: `${capitalize(np)}'s turn - Roll the dice!`, isTransitioning: !prev.options.isAIMode && prev.players.length > 1, turnSnapshot: prev.tokens.map(t => ({ ...t })) };
  }, []);

  const startExtraTurn = useCallback((prev: GameState, reason: string): GameState => {
    return { ...prev, diceRolled: false, diceValues: [], pendingDice: [], selectedDiceIndex: null, pendingExtraRoll: false, pendingBonusReason: '', missedCaptureTargets: [], capturedThisTurn: false, message: `${capitalize(getCurrentPlayer(prev))} gets another turn! (${reason})` };
  }, []);

  const rollDice = useCallback(() => {
    const state = stateRef.current;
    if (!state || state.diceRolled || state.winner || rollingRef.current) return;
    setIsRolling(true); rollingRef.current = true;
    const diceCount = state.options.diceCount;
    const rollDuration = 500;
    const startTime = Date.now();
    const animateRoll = () => {
      const elapsed = Date.now() - startTime;
      if (elapsed < rollDuration) {
        const tempValues = Array.from({ length: diceCount }, () => Math.floor(Math.random() * 6) + 1);
        setGameState(prev => prev ? { ...prev, diceValues: [...prev.pendingDice, ...tempValues] } : null);
        requestAnimationFrame(animateRoll);
      } else {
        const finalValues = Array.from({ length: diceCount }, () => Math.floor(Math.random() * 6) + 1);
        setGameState(prev => {
          if (!prev) return null;
          const player = getCurrentPlayer(prev);
          const hasSix = rollHasSix(finalValues);
          const isDouble = isDoubleSix(finalValues);
          let newConsecutiveSixes = prev.consecutiveSixes;
          if (prev.options.diceCount === 1) { newConsecutiveSixes = finalValues[0] === 6 ? newConsecutiveSixes + 1 : 0; }
          else { newConsecutiveSixes = isDouble ? newConsecutiveSixes + 1 : 0; }
          if (shouldReverseTurn(prev.options, newConsecutiveSixes)) {
            const restored = prev.turnSnapshot.map(t => ({ ...t }));
            return { ...transitionToNextPlayer({ ...prev, tokens: restored, consecutiveSixes: 0 }), message: prev.options.diceCount === 1 ? `⚠️ 3 consecutive 6s! ${capitalize(player)}'s turn is reversed!` : `⚠️ 2 consecutive double 6s! ${capitalize(player)}'s turn is reversed!` };
          }

          // Accumulate this roll's dice onto the pool from earlier bonus rolls.
          const newPendingDice = [...prev.pendingDice, ...finalValues];
          const newDiceValues = [...prev.pendingDice, ...finalValues];

          // If this roll earns another roll, keep rolling BEFORE moving.
          const extraFromDice = shouldGetExtraTurnFromDice(prev.options, finalValues);
          if (extraFromDice) {
            return {
              ...prev,
              diceValues: newDiceValues,
              pendingDice: newPendingDice,
              selectedDiceIndex: null,
              diceRolled: false,
              pendingExtraRoll: true,
              consecutiveSixes: newConsecutiveSixes,
              rollHasSix: hasSix,
              message: prev.options.diceCount === 1
                ? `${capitalize(player)} rolled a 6! Roll again!`
                : `${capitalize(player)} rolled double 6! Roll again!`,
            };
          }

          // No more bonus rolls: the player moves with the full accumulated pool.
          const anyValid = getValidMovesForAnyDice(prev.tokens, player, newPendingDice, prev.captureCounts);
          const hasValidMoves = anyValid.length > 0;
          const captureTargets = getCapturableOwnTokens(prev.tokens, player, newPendingDice, prev.options)
            .map(t => `${t.player}-${t.id}`);
          let message = prev.options.diceCount === 1 ? `${capitalize(player)} rolled a ${finalValues[0]}!` : `${capitalize(player)} rolled ${finalValues[0]} & ${finalValues[1]}!`;
          if (!hasValidMoves) message += ' No valid moves.';
          else if (newPendingDice.length === 1) message += ' Tap a token to move.';
          else message += ' Select a die, then tap a token.';
          return { ...prev, diceValues: newDiceValues, pendingDice: newPendingDice, selectedDiceIndex: newPendingDice.length === 1 ? 0 : null, diceRolled: true, pendingExtraRoll: false, consecutiveSixes: newConsecutiveSixes, rollHasSix: hasSix, missedCaptureTargets: captureTargets, capturedThisTurn: false, message };
        });
        setIsRolling(false); rollingRef.current = false;
      }
    };
    requestAnimationFrame(animateRoll);
  }, [transitionToNextPlayer]);

  const handleSelectDice = useCallback((index: number) => {
    setGameState(prev => prev ? { ...prev, selectedDiceIndex: index } : null);
  }, []);

  const handleTokenClick = useCallback((token: Token) => {
    setGameState(prev => {
      if (!prev || !prev.diceRolled || prev.pendingDice.length === 0) return prev;
      const cp = getCurrentPlayer(prev);
      if (token.player !== cp) return prev;
      let diceValue: number, diceIndex: number;
      if (prev.selectedDiceIndex !== null) { diceIndex = prev.selectedDiceIndex; diceValue = prev.pendingDice[diceIndex]; }
      else {
        // With several dice, prefer the die that makes this move a capture so
        // the mandatory-capture rule is honored; otherwise use the first die
        // that makes the token a valid move.
        let idx = -1;
        for (let i = 0; i < prev.pendingDice.length; i++) {
          const dv = prev.pendingDice[i];
          const isValid = getValidMoves(prev.tokens, cp, dv, prev.captureCounts).some(t => t.id === token.id && t.player === token.player);
          if (!isValid) continue;
          if (moveWouldCapture(prev.tokens, token, dv)) { idx = i; break; }
          if (idx === -1) idx = i;
        }
        if (idx === -1) return prev;
        diceIndex = idx;
        diceValue = prev.pendingDice[idx];
      }
      if (!getValidMoves(prev.tokens, cp, diceValue, prev.captureCounts).some(t => t.id === token.id && t.player === token.player)) return prev;
      const { tokens: movedTokens, captured, enteredBoard, captureCounts } = executeMove(prev.tokens, token, diceValue, prev.captureCounts);

      const newTokens = movedTokens;
      const newCaptureCounts = captureCounts;
      const capturedThisTurn = prev.capturedThisTurn || captured;

      // ─── Ranking & game-end logic ───────────────────────────────────────
      // The current player may have just finished. If so, add them to the
      // finishedOrder. The game ends as soon as the second-last player
      // finishes (i.e. only one player is left unranked).
      const playerFinished = hasPlayerFinished(newTokens, cp);
      const finishedOrder = playerFinished
        ? registerFinishedPlayer(prev.finishedOrder, cp, newTokens)
        : prev.finishedOrder;
      const shouldEndGame = finishedOrder.length >= prev.players.length - 1;
      const winner = shouldEndGame ? (finishedOrder[0] ?? null) : null;

      // Capture/entry bonuses happen AFTER a move, so they can't be pre-rolled.
      // Track the reason so it survives a multi-dice move phase.
      let pendingBonusReason = prev.pendingBonusReason;
      if (captured && prev.options.extraTurnOnCapture) pendingBonusReason = 'captured';
      else if (enteredBoard && prev.options.extraRollOnEntry) pendingBonusReason = 'entered board';

      const newPendingDice = [...prev.pendingDice]; newPendingDice.splice(diceIndex, 1);
      const isChooseMode = prev.options.diceCount === 2 && prev.options.twoDiceMode === 'choose';
      if (isChooseMode && !prev.rollHasSix && newPendingDice.length > 0) newPendingDice.length = 0;
      if (newPendingDice.length > 0 && getValidMovesForAnyDice(newTokens, cp, newPendingDice, newCaptureCounts).length === 0) newPendingDice.length = 0;
      const updated = { ...prev, tokens: newTokens, captureCounts: newCaptureCounts, finishedOrder, capturedThisTurn };
      if (newPendingDice.length === 0) {
        // ─── Missed-capture penalty ───────────────────────────────────────
        // A capture is no longer forced. If the player ends the turn without
        // capturing, any of their OWN pieces that could have captured (when
        // the move phase began) and are still on the board are sent home.
        const penalty = capturedThisTurn
          ? { tokens: newTokens, removedCount: 0 }
          : applyMissedCapturePenalty(newTokens, cp, prev.missedCaptureTargets);
        const finalTokens = penalty.tokens;
        const missedMessage = formatMissedCaptureMessage(cp, penalty.removedCount);
        const finalUpdated = { ...updated, tokens: finalTokens, missedCaptureTargets: [], capturedThisTurn: false };

        if (winner) {
          // Final ranking: everyone who finished (1st, 2nd, …) followed by
          // whoever is left over (the last place).
          const remaining = prev.players.filter(p => !finishedOrder.includes(p));
          const ranking = [...finishedOrder, ...remaining];
          const rankingText = ranking.map((p, i) => `${i + 1}. ${capitalize(p)}`).join(' • ');
          return { ...finalUpdated, pendingDice: [], selectedDiceIndex: null, diceRolled: false, diceValues: [], winner, message: `🏆 Game over! ${rankingText}` };
        }
        if (playerFinished && !shouldEndGame) {
          // Mark the player's finish in the message and let the game continue
          // for the remaining players.
          const place = finishedOrder.length; // 1, 2, ...
          const suffix = ['1st', '2nd', '3rd', '4th'][place - 1] ?? `${place}th`;
          const nextState = transitionToNextPlayer({ ...finalUpdated, pendingDice: [], selectedDiceIndex: null, diceValues: [], diceRolled: false });
          return { ...nextState, message: `🎉 ${capitalize(cp)} finished in ${suffix} place! ${nextState.message}${missedMessage ? ' ' + missedMessage : ''}` };
        }
        if (pendingBonusReason) {
          const bonusState = startExtraTurn({ ...finalUpdated, pendingDice: [], selectedDiceIndex: null, diceValues: [], diceRolled: false, pendingBonusReason: '' }, pendingBonusReason);
          return { ...bonusState, message: bonusState.message + (missedMessage ? ' ' + missedMessage : '') };
        }
        const nextState = transitionToNextPlayer({ ...finalUpdated, pendingDice: [], selectedDiceIndex: null, diceValues: [], diceRolled: false });
        return { ...nextState, message: nextState.message + (missedMessage ? ' ' + missedMessage : '') };
      }
      return { ...updated, pendingDice: newPendingDice, selectedDiceIndex: newPendingDice.length === 1 ? 0 : null, pendingBonusReason, message: (newPendingDice.length === 1 ? `Tap a token to move ${newPendingDice[0]} steps.` : 'Select a die, then tap a token.') };
    });
  }, [transitionToNextPlayer, startExtraTurn]);

  const handleNoMoves = useCallback(() => {
    setGameState(prev => {
      if (!prev) return prev;
      // Dice-based bonuses are pre-rolled now, so "no valid moves" simply
      // ends the turn and passes play to the next player.
      return transitionToNextPlayer(prev);
    });
  }, [transitionToNextPlayer]);

  const handleReady = useCallback(() => { setGameState(prev => prev ? { ...prev, isTransitioning: false } : prev); }, []);

  // ─── AI Turn Logic ──────────────────────────────────────────────────────

  useEffect(() => {
    const state = stateRef.current;
    if (!state || state.winner || rollingRef.current || state.isTransitioning) return;
    if (isHumanTurn(state)) return;
    // If current player already finished, just advance.
    if ((state.finishedOrder || []).includes(getCurrentPlayer(state))) {
      const t = setTimeout(() => handleNoMoves(), 400);
      return () => clearTimeout(t);
    }
    if (!state.diceRolled) { const t = setTimeout(() => rollDice(), 900); return () => clearTimeout(t); }
    else if (state.pendingDice.length > 0) {
      const t = setTimeout(() => {
        const cs = stateRef.current;
        if (!cs || !cs.diceRolled || cs.pendingDice.length === 0) return;
        const aiPlayer = getCurrentPlayer(cs);
        if (cs.pendingDice.length > 1) {
          const move = getAIMoveTwoDice(cs.tokens, aiPlayer, cs.pendingDice, cs.captureCounts);
          if (move) { setGameState(p => p ? { ...p, selectedDiceIndex: move.diceIndex } : null); setTimeout(() => handleTokenClick(move.token), 300); }
          else handleNoMoves();
        } else {
          const move = getAIMove(cs.tokens, aiPlayer, cs.pendingDice[0], cs.captureCounts);
          if (move) handleTokenClick(move); else handleNoMoves();
        }
      }, 700);
      return () => clearTimeout(t);
    }
  }, [gameState?.currentPlayerIndex, gameState?.diceRolled, gameState?.pendingDice.length, gameState?.winner, gameState?.isTransitioning, handleNoMoves]);

  // Auto-pass when no valid moves (human)
  useEffect(() => {
    const state = stateRef.current;
    if (!state || state.winner || !state.diceRolled || state.pendingDice.length === 0 || state.isTransitioning) return;
    if (!isHumanTurn(state)) return;
    if (getValidMovesForAnyDice(state.tokens, getCurrentPlayer(state), state.pendingDice, state.captureCounts).length === 0) {
      const t = setTimeout(() => handleNoMoves(), 1000); return () => clearTimeout(t);
    }
  }, [gameState?.diceRolled, gameState?.pendingDice.length, gameState?.isTransitioning, handleNoMoves]);

  // ─── Online Game Actions ────────────────────────────────────────────────

  const onlineRollDice = useCallback(() => {
    if (!socket || !roomInfo || !onlineGameState) return;
    const cp = getCurrentPlayer(onlineGameState);
    if (myColor !== cp || onlineGameState.diceRolled) return;
    socket.emit('roll-dice', { roomId: roomInfo.id });
  }, [socket, roomInfo, onlineGameState, myColor]);

  useEffect(() => {
    const onRollShortcut = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (screen !== 'game' || adminPortalOpen) return;
      if (isEditableTarget(event.target)) return;

      const isRollShortcut = event.key.toLowerCase() === 'r' || event.code === 'Space';
      if (!isRollShortcut) return;

      // Only consume the key when there's a dice to roll (i.e. the dice
      // haven't been rolled yet for this turn AND it's the human's turn).
      const gs = onlineGameState ?? gameState;
      if (!gs) return;
      if (gs.winner) return;
      if (gs.diceRolled || isRolling) return;
      if (gs.isTransitioning) return;
      if (onlineGameState && myColor !== getCurrentPlayer(gs)) return;
      if (!onlineGameState && !isHumanTurn(gs)) return;

      event.preventDefault();
      if (onlineGameState) {
        onlineRollDice();
      } else {
        rollDice();
      }
    };

    window.addEventListener('keydown', onRollShortcut);
    return () => window.removeEventListener('keydown', onRollShortcut);
  }, [screen, adminPortalOpen, onlineGameState, gameState, isRolling, myColor, onlineRollDice, rollDice]);

  const onlineSelectDice = useCallback((index: number) => {
    if (!socket || !roomInfo) return;
    socket.emit('select-dice', { roomId: roomInfo.id, diceIndex: index });
  }, [socket, roomInfo]);

  const onlineMoveToken = useCallback((token: Token) => {
    if (!socket || !roomInfo || !onlineGameState) return;
    const cp = getCurrentPlayer(onlineGameState);
    if (myColor !== cp || token.player !== cp) return;
    socket.emit('move-token', { roomId: roomInfo.id, tokenId: token.id, player: token.player });
  }, [socket, roomInfo, onlineGameState, myColor]);

  const resumeLocalGame = useCallback((gameId: string) => {
    const savedGames = loadLocalSavedGames();
    const savedGame = savedGames.find(game => game.gameId === gameId);
    if (!savedGame) return;
    setOnlineGameState(null);
    setSocket(prev => {
      if (prev) {
        prev.disconnect();
      }
      return null;
    });
    setRoomInfo(null);
    setMyColor(null);
    setInvites([]);
    setGameState(normalizeGameState(savedGame.gameState));
    setScreen('game');
  }, []);

  const resumeOnlineGame = useCallback((gameId: string) => {
    if (!socket) return;
    socket.emit('resume-game', { gameId });
  }, [socket]);

  const adminPortal = (
    <AdminPortal
      open={adminPortalOpen}
      onClose={() => setAdminPortalOpen(false)}
      onRefreshLocal={() => setLocalSavedGames(loadLocalSavedGames())}
    />
  );



  // ─── Render Screens ────────────────────────────────────────────────────

  if (screen === 'start') {
    return <>{adminPortal}<StartScreen onLocal={() => setScreen('options')} onOnline={() => setScreen('online-login')} savedGames={localSavedGames} onResumeLocal={resumeLocalGame} /></>;
  }

  if (screen === 'options') {
    return <>{adminPortal}<OptionsScreen onStart={(options, pc) => {
      const players: PlayerColor[] = ['green','yellow','red','blue'].slice(0, pc) as PlayerColor[];
      setGameState(createInitialState(players, options));
      setScreen('game');
    }} onBack={() => setScreen('start')} /></>;
  }

  if (screen === 'online-login') {
    return <>{adminPortal}<OnlineLoginScreen onConnect={(sock, uname, savedGames, posStats) => {
      setSocket(sock); setOnlineUsername(uname); setOnlineSavedGames(savedGames); setPositionStats(posStats || emptyPositionStats()); setScreen('online-lobby');
    }} /></>;
  }

  if (screen === 'online-lobby') {
    return <>{adminPortal}<OnlineLobbyScreen socket={socket!} username={onlineUsername} onlineUsers={onlineUsers} roomInfo={roomInfo} invites={invites} savedGames={onlineSavedGames} positionStats={positionStats} voice={voice}
      onResumeGame={resumeOnlineGame}
      onBack={() => { socket?.disconnect(); setSocket(null); setRoomInfo(null); setInvites([]); setOnlineUsers([]); setOnlineSavedGames([]); setPositionStats(null); setScreen('start'); }} />;
    </>;
  }

  // ─── Game Screen ────────────────────────────────────────────────────────

  if (screen === 'game') {
    const isOnline = !!onlineGameState;
    const gs = isOnline ? onlineGameState! : gameState!;

    if (!gs) { setScreen('start'); return null; }

    if (isOnline && roomInfo?.paused) {
      const isHost = roomInfo.host === onlineUsername;
      return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4 text-center">
          <div className="max-w-md w-full bg-white/10 backdrop-blur-lg border border-white/20 rounded-3xl p-6 shadow-2xl">
            <h2 className="text-white text-2xl font-bold mb-2">Game paused</h2>
            <p className="text-white/60 text-sm mb-4">A player left the match. Choose how to continue.</p>
            {roomInfo.vacantSlots?.length ? (
              <div className="mb-4 space-y-2 text-left">
                {roomInfo.vacantSlots.map(slot => {
                  const invitedBy = Object.entries(roomInfo.pendingReplacements ?? {})
                    .find(([, color]) => color === slot.color)?.[0];
                  return (
                    <div key={`${slot.username}-${slot.color}`} className="rounded-xl bg-white/5 px-3 py-2">
                      <div className="flex items-center justify-between">
                        <span className="text-white text-sm flex items-center gap-2">
                          <span className="w-3.5 h-3.5 rounded-full border" style={{ backgroundColor: PLAYER_COLORS[slot.color].bg, borderColor: PLAYER_COLORS[slot.color].dark }} />
                          {capitalize(slot.username)} left
                        </span>
                        <span className="text-white/40 text-xs">{capitalize(slot.color)}</span>
                      </div>
                      {invitedBy
                        ? <p className="text-amber-300/80 text-xs mt-1">⏳ {invitedBy} invited to take over this position</p>
                        : isHost && (
                          <button
                            onClick={() => socket?.emit('continue-without-player', { roomId: roomInfo.id, playerName: slot.username })}
                            className="mt-2 w-full px-3 py-1.5 rounded-lg bg-green-500/80 text-white text-xs font-semibold">
                            Continue without {capitalize(slot.username)}
                          </button>
                        )}
                    </div>
                  );
                })}
              </div>
            ) : null}
            {isHost ? (
              <div className="flex flex-col gap-3">
                <p className="text-white/50 text-xs">Invite a replacement and choose which position they take over, or drop a player to resume.</p>
                <button onClick={() => setScreen('online-lobby')} className="px-4 py-3 rounded-xl bg-blue-500 text-white font-semibold">Invite a replacement</button>
              </div>
            ) : (
              <p className="text-white/50 text-sm">Waiting for the host to decide.</p>
            )}
          </div>
        </div>
      );
    }

    // Pass & Play transition
    if (!isOnline && gs.isTransitioning) {
      const player = getCurrentPlayer(gs);
      const colors = PLAYER_COLORS[player];
      const reversalMsg = gs.message.includes('reversed') ? gs.message : undefined;
      return <>{adminPortal}<div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-4">
          <div className="text-center">
            <div className="w-24 h-24 rounded-full mx-auto mb-6 shadow-2xl flex items-center justify-center" style={{ backgroundColor: colors.bg, border: `4px solid ${colors.dark}` }}>
              <span className="text-4xl font-bold text-white">{capitalize(player).charAt(0)}</span>
            </div>
            <h2 className="text-2xl font-bold text-white mb-2">{capitalize(player)}'s Turn</h2>
            {reversalMsg && <p className="text-amber-400 text-sm mb-2 font-medium">{reversalMsg}</p>}
            <p className="text-white/50 text-sm mb-8">Pass the device to the {capitalize(player)} player</p>
            <button onClick={handleReady} className="px-8 py-3 rounded-xl text-white font-bold text-lg shadow-lg hover:scale-105 transition-transform active:scale-95" style={{ backgroundColor: colors.bg }}>I'm Ready! 👋</button>
          </div>
        </div></>;
    }

    return <>{adminPortal}<GameBoard gameState={gs} boardSize={boardSize} myColor={myColor} isOnline={isOnline} isRolling={isRolling}
      onTokenClick={isOnline ? onlineMoveToken : handleTokenClick}
      onRollDice={isOnline ? onlineRollDice : rollDice}
      onSelectDice={isOnline ? onlineSelectDice : handleSelectDice}
      onPlayAgain={() => {
        if (isOnline) return;
        const current = gameState;
        if (current) setGameState(createInitialState(current.players, current.options));
      }}
      onNewGame={() => {
        if (isOnline) { socket?.disconnect(); setSocket(null); setOnlineGameState(null); setRoomInfo(null); setMyColor(null); setInvites([]); }
        else { setGameState(null); }
        setScreen('start');
      }} />{isOnline && roomInfo && <VoicePanel voice={voice} me={onlineUsername} floating />}</>;
  }

  return null;
}
