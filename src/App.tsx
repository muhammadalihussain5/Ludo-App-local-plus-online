import { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  type PlayerColor, type GameState, type Token, type GameOptions,
  PLAYER_COLORS, START_INDICES, getCellInfo, getTokenPosition,
  getValidMoves, getValidMovesForAnyDice, executeMove, checkWin,
  createInitialState, getCurrentPlayer, isHumanTurn, capitalize,
  shouldReverseTurn, shouldGetExtraTurnFromDice, rollHasSix, isDoubleSix,
  getAIMove, getAIMoveTwoDice,
} from './gameLogic';

const DEFAULT_OPTIONS: GameOptions = {
  extraRollOnEntry: true, extraTurnOnCapture: true,
  diceCount: 1, twoDiceMode: 'both', isAIMode: true,
};

// ─── Types ───────────────────────────────────────────────────────────────────

type Screen = 'start' | 'options' | 'online-login' | 'online-lobby' | 'game';

interface RoomInfo {
  id: string; host: string; players: string[];
  playerColors: Record<string, PlayerColor>; options: GameOptions;
  started: boolean; playerCount: number;
}

interface InviteInfo { roomId: string; from: string; playerCount: number; }

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

function StartScreen({ onLocal, onOnline }: { onLocal: () => void; onOnline: () => void }) {
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

function OnlineLoginScreen({ onConnect }: { onConnect: (socket: Socket, username: string) => void }) {
  const [serverUrl, setServerUrl] = useState(() => import.meta.env.VITE_SERVER_URL || 'https://ludo-app-local-plus-online.onrender.com/');
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);

  const handleConnect = () => {
    if (!username.trim() || username.trim().length < 2) { setError('Username must be at least 2 characters'); return; }
    setConnecting(true); setError('');
    const socket = io(serverUrl, { transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      socket.emit('login', username.trim());
    });

    socket.on('login-success', (data: { username: string }) => {
      setConnecting(false);
      onConnect(socket, data.username);
    });

    socket.on('login-error', (data: { message: string }) => {
      setConnecting(false);
      setError(data.message);
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
        <div className="space-y-4">
          <div>
            <label className="text-white/70 text-sm mb-1 block">Server URL</label>
            <input type="text" value={serverUrl} onChange={e => setServerUrl(e.target.value)}
              className="w-full px-4 py-3 rounded-xl bg-white/10 border border-white/20 text-white placeholder-white/30 focus:outline-none focus:border-blue-400"
              placeholder="http://localhost:3001" />
          </div>
          <div>
            <label className="text-white/70 text-sm mb-1 block">Your Username</label>
            <input type="text" value={username} onChange={e => setUsername(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleConnect()}
              className="w-full px-4 py-3 rounded-xl bg-white/10 border border-white/20 text-white placeholder-white/30 focus:outline-none focus:border-blue-400"
              placeholder="Enter your name" />
          </div>
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          <button onClick={handleConnect} disabled={connecting}
            className="w-full py-3 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-bold shadow-lg hover:scale-105 transition-transform active:scale-95 disabled:opacity-50">
            {connecting ? 'Connecting...' : 'Connect & Login'}
          </button>
        </div>
        <div className="mt-4 text-center">
          <p className="text-white/30 text-xs">For production, enter your Render backend URL, for example: https://your-app.onrender.com</p>
          <p className="text-white/30 text-xs mt-1">Local dev: <code className="bg-white/10 px-1.5 py-0.5 rounded">cd server && npm start</code></p>
        </div>
      </div>
    </div>
  );
}

// ─── Online Lobby Screen ─────────────────────────────────────────────────────

function OnlineLobbyScreen({ socket, username, onlineUsers, roomInfo, invites, onBack }: {
  socket: Socket; username: string; onlineUsers: string[]; roomInfo: RoomInfo | null;
  invites: InviteInfo[]; onBack: () => void;
}) {
  const [playerCount, setPlayerCount] = useState(4);
  const [options, setOptions] = useState<GameOptions>({ ...DEFAULT_OPTIONS, isAIMode: false });
  const [inviteUsername, setInviteUsername] = useState('');

  const createRoom = () => {
    socket.emit('create-room', { playerCount, options });
  };

  const invitePlayer = () => {
    if (!inviteUsername.trim() || !roomInfo) return;
    socket.emit('invite-player', { roomId: roomInfo.id, username: inviteUsername.trim() });
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
            <div className="mt-3 flex gap-2">
              <input type="text" value={inviteUsername} onChange={e => setInviteUsername(e.target.value)} placeholder="Enter username to invite"
                className="flex-1 px-3 py-2 rounded-lg bg-white/10 border border-white/20 text-white text-sm placeholder-white/30 focus:outline-none focus:border-blue-400" />
              <button onClick={invitePlayer} disabled={!isHost || !inviteUsername.trim()} className="px-4 py-2 bg-blue-500 text-white text-sm rounded-lg font-medium disabled:opacity-30">Invite</button>
            </div>
            {!isHost && <p className="text-white/30 text-xs mt-2">Only the host can invite and start</p>}
            {isHost && roomInfo.players.length >= roomInfo.playerCount && (
              <button onClick={startGame} className="w-full mt-3 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-bold rounded-xl shadow-lg hover:scale-105 transition-transform active:scale-95">
                🎮 Start Game!
              </button>
            )}
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
              <button onClick={createRoom} className="w-full py-3 bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-bold rounded-xl shadow-lg hover:scale-105 transition-transform active:scale-95">
                Create Room
              </button>
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
                  {roomInfo && isHost && !roomInfo.players.includes(u) && roomInfo.players.length < roomInfo.playerCount && (
                    <button onClick={() => { socket.emit('invite-player', { roomId: roomInfo.id, username: u }); }} className="px-3 py-1 bg-blue-500/50 text-white text-xs rounded-lg">Invite</button>
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

// ─── Score Board ─────────────────────────────────────────────────────────────

function ScoreBoard({ state, myColor }: { state: GameState; myColor?: PlayerColor | null }) {
  return (
    <div className="flex gap-2 flex-wrap justify-center">
      {state.players.map(player => {
        const colors = PLAYER_COLORS[player];
        const finished = state.tokens.filter(t => t.player === player && t.steps >= 56).length;
        const isCurrent = getCurrentPlayer(state) === player;
        const isMe = myColor === player;
        return (
          <div key={player} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-xl border-2 transition-all duration-300 ${isCurrent ? 'scale-110 shadow-lg' : 'opacity-60'}`}
            style={{ backgroundColor: colors.light, borderColor: isCurrent ? colors.dark : colors.border }}>
            <div className="w-3.5 h-3.5 rounded-full border" style={{ backgroundColor: colors.bg, borderColor: colors.dark }} />
            <span className="text-xs font-bold" style={{ color: colors.text }}>{capitalize(player)}</span>
            <span className="text-xs font-medium" style={{ color: colors.dark }}>{finished}/4</span>
            {isMe && <span className="text-xs" style={{ color: colors.dark }}>⭐</span>}
          </div>
        );
      })}
    </div>
  );
}

// ─── Game Board Component ────────────────────────────────────────────────────

function GameBoard({ gameState, boardSize, myColor, isOnline, isRolling, onTokenClick, onRollDice, onSelectDice, onNewGame }: {
  gameState: GameState; boardSize: number; myColor?: PlayerColor | null;
  isOnline: boolean; isRolling: boolean;
  onTokenClick: (token: Token) => void; onRollDice: () => void;
  onSelectDice: (index: number) => void; onNewGame: () => void;
}) {
  const currentPlayer = getCurrentPlayer(gameState);
  const isMyTurn = isOnline ? myColor === currentPlayer : isHumanTurn(gameState);
  const isHuman = isOnline ? isMyTurn : isHumanTurn(gameState);

  const activeDiceValue = gameState.selectedDiceIndex !== null ? gameState.pendingDice[gameState.selectedDiceIndex] : null;
  const validMoves = gameState.diceRolled && gameState.pendingDice.length > 0 && isHuman
    ? activeDiceValue !== null ? getValidMoves(gameState.tokens, currentPlayer, activeDiceValue) : getValidMovesForAnyDice(gameState.tokens, currentPlayer, gameState.pendingDice)
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
              <button onClick={onRollDice} disabled={gameState.diceRolled || isRolling}
                className={`px-6 py-2.5 rounded-xl font-bold text-sm shadow-lg transition-all ${gameState.diceRolled || isRolling ? 'bg-gray-600 text-gray-400 cursor-not-allowed' : 'bg-gradient-to-r from-yellow-400 to-orange-500 text-white hover:scale-105 active:scale-95'}`}>
                {isRolling ? 'Rolling...' : gameState.diceRolled ? 'Tap a Token' : 'Roll Dice 🎲'}
              </button>
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
        {gameState.winner && (
          <div className="mt-4 text-center">
            <div className="inline-block px-8 py-4 rounded-2xl font-bold text-xl text-white shadow-xl animate-bounce" style={{ backgroundColor: PLAYER_COLORS[gameState.winner].bg }}>🎉 {capitalize(gameState.winner)} Wins! 🎉</div>
            <div className="mt-3"><button onClick={onNewGame} className="px-6 py-2 bg-white/20 text-white rounded-xl font-medium hover:bg-white/30 transition-colors">Play Again</button></div>
          </div>
        )}
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

  // Online state
  const [socket, setSocket] = useState<Socket | null>(null);
  const [onlineUsername, setOnlineUsername] = useState('');
  const [onlineUsers, setOnlineUsers] = useState<string[]>([]);
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [invites, setInvites] = useState<InviteInfo[]>([]);
  const [myColor, setMyColor] = useState<PlayerColor | null>(null);
  const [onlineGameState, setOnlineGameState] = useState<GameState | null>(null);

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

    const onGameStarted = (data: { roomId: string; gameState: GameState; playerColors: Record<string, PlayerColor> }) => {
      setOnlineGameState(data.gameState);
      setRoomInfo(prev => prev ? { ...prev, started: true } : null);
      setScreen('game');
    };

    const onGameState = (data: { gameState: GameState }) => {
      setOnlineGameState(data.gameState);
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
    socket.on('game-state', onGameState);
    socket.on('dice-rolled', onDiceRolled);
    socket.on('your-color', onYourColor);
    socket.on('player-disconnected', onPlayerDisconnected);

    return () => {
      socket.off('online-users', onOnlineUsers);
      socket.off('room-created', onRoomCreated);
      socket.off('room-updated', onRoomUpdated);
      socket.off('room-invite', onRoomInvite);
      socket.off('invite-rejected', onInviteRejected);
      socket.off('game-started', onGameStarted);
      socket.off('game-state', onGameState);
      socket.off('dice-rolled', onDiceRolled);
      socket.off('your-color', onYourColor);
      socket.off('player-disconnected', onPlayerDisconnected);
    };
  }, [socket]);

  // ─── Local Game Logic (same as before) ─────────────────────────────────

  const transitionToNextPlayer = useCallback((prev: GameState, overrideIndex?: number): GameState => {
    const npi = overrideIndex !== undefined ? overrideIndex : (prev.currentPlayerIndex + 1) % prev.players.length;
    const np = prev.players[npi];
    return { ...prev, diceRolled: false, diceValues: [], pendingDice: [], selectedDiceIndex: null, currentPlayerIndex: npi, earnedExtraTurn: false, consecutiveSixes: 0, rollHasSix: false, message: `${capitalize(np)}'s turn - Roll the dice!`, isTransitioning: !prev.options.isAIMode && prev.players.length > 1, turnSnapshot: prev.tokens.map(t => ({ ...t })) };
  }, []);

  const startExtraTurn = useCallback((prev: GameState, reason: string): GameState => {
    return { ...prev, diceRolled: false, diceValues: [], pendingDice: [], selectedDiceIndex: null, earnedExtraTurn: false, message: `${capitalize(getCurrentPlayer(prev))} gets another turn! (${reason})` };
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
        setGameState(prev => prev ? { ...prev, diceValues: tempValues } : null);
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
          const pendingDice = prev.options.diceCount === 1 ? [finalValues[0]] : [...finalValues];
          const anyValid = getValidMovesForAnyDice(prev.tokens, player, pendingDice);
          const hasValidMoves = anyValid.length > 0;
          const extraFromDice = shouldGetExtraTurnFromDice(prev.options, finalValues);
          let message = prev.options.diceCount === 1 ? `${capitalize(player)} rolled a ${finalValues[0]}!` : `${capitalize(player)} rolled ${finalValues[0]} & ${finalValues[1]}!`;
          if (!hasValidMoves) message += ' No valid moves.';
          else if (pendingDice.length === 1) message += ' Tap a token to move.';
          else message += ' Select a die, then tap a token.';
          return { ...prev, diceValues: finalValues, pendingDice, selectedDiceIndex: pendingDice.length === 1 ? 0 : null, diceRolled: true, earnedExtraTurn: extraFromDice, consecutiveSixes: newConsecutiveSixes, rollHasSix: hasSix, message };
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
      else { const idx = prev.pendingDice.findIndex(dv => getValidMoves(prev.tokens, cp, dv).some(t => t.id === token.id && t.player === token.player)); if (idx === -1) return prev; diceIndex = idx; diceValue = prev.pendingDice[idx]; }
      if (!getValidMoves(prev.tokens, cp, diceValue).some(t => t.id === token.id && t.player === token.player)) return prev;
      const { tokens: newTokens, captured, enteredBoard } = executeMove(prev.tokens, token, diceValue);
      const winner = checkWin(newTokens, cp) ? cp : null;
      const extraFromDice = prev.earnedExtraTurn;
      const extraFromCapture = captured && prev.options.extraTurnOnCapture;
      const extraFromEntry = enteredBoard && prev.options.extraRollOnEntry;
      const anyExtraTurn = extraFromDice || extraFromCapture || extraFromEntry;
      const newPendingDice = [...prev.pendingDice]; newPendingDice.splice(diceIndex, 1);
      const isChooseMode = prev.options.diceCount === 2 && prev.options.twoDiceMode === 'choose';
      if (isChooseMode && !prev.rollHasSix && newPendingDice.length > 0) newPendingDice.length = 0;
      if (newPendingDice.length > 0 && getValidMovesForAnyDice(newTokens, cp, newPendingDice).length === 0) newPendingDice.length = 0;
      const updated = { ...prev, tokens: newTokens };
      if (newPendingDice.length === 0) {
        if (winner) return { ...updated, pendingDice: [], selectedDiceIndex: null, diceRolled: false, diceValues: [], winner, message: `🎉 ${capitalize(winner)} wins! 🎉` };
        if (anyExtraTurn) { const reasons: string[] = []; if (extraFromDice) reasons.push(prev.options.diceCount === 1 ? 'rolled 6' : 'double 6'); if (extraFromCapture) reasons.push('captured'); if (extraFromEntry) reasons.push('entered board'); return startExtraTurn({ ...updated, pendingDice: [], selectedDiceIndex: null, diceValues: [], diceRolled: false }, reasons.join(' & ')); }
        return transitionToNextPlayer({ ...updated, pendingDice: [], selectedDiceIndex: null, diceValues: [], diceRolled: false });
      }
      return { ...updated, pendingDice: newPendingDice, selectedDiceIndex: newPendingDice.length === 1 ? 0 : null, earnedExtraTurn: anyExtraTurn, message: newPendingDice.length === 1 ? `Tap a token to move ${newPendingDice[0]} steps.` : 'Select a die, then tap a token.' };
    });
  }, [transitionToNextPlayer, startExtraTurn]);

  const handleNoMoves = useCallback(() => {
    setGameState(prev => {
      if (!prev) return prev;
      if (prev.earnedExtraTurn) return startExtraTurn({ ...prev, diceRolled: false, diceValues: [], pendingDice: [], selectedDiceIndex: null, earnedExtraTurn: false }, prev.options.diceCount === 1 ? 'rolled 6' : 'double 6');
      return transitionToNextPlayer(prev);
    });
  }, [transitionToNextPlayer, startExtraTurn]);

  const handleReady = useCallback(() => { setGameState(prev => prev ? { ...prev, isTransitioning: false } : prev); }, []);

  // ─── AI Turn Logic ──────────────────────────────────────────────────────

  useEffect(() => {
    const state = stateRef.current;
    if (!state || state.winner || rollingRef.current || state.isTransitioning) return;
    if (isHumanTurn(state)) return;
    if (!state.diceRolled) { const t = setTimeout(() => rollDice(), 900); return () => clearTimeout(t); }
    else if (state.pendingDice.length > 0) {
      const t = setTimeout(() => {
        const cs = stateRef.current;
        if (!cs || !cs.diceRolled || cs.pendingDice.length === 0) return;
        const aiPlayer = getCurrentPlayer(cs);
        if (cs.pendingDice.length > 1) {
          const move = getAIMoveTwoDice(cs.tokens, aiPlayer, cs.pendingDice);
          if (move) { setGameState(p => p ? { ...p, selectedDiceIndex: move.diceIndex } : null); setTimeout(() => handleTokenClick(move.token), 300); }
          else handleNoMoves();
        } else {
          const move = getAIMove(cs.tokens, aiPlayer, cs.pendingDice[0]);
          if (move) handleTokenClick(move); else handleNoMoves();
        }
      }, 700);
      return () => clearTimeout(t);
    }
  }, [gameState?.currentPlayerIndex, gameState?.diceRolled, gameState?.pendingDice.length, gameState?.winner, gameState?.isTransitioning]);

  // Auto-pass when no valid moves (human)
  useEffect(() => {
    const state = stateRef.current;
    if (!state || state.winner || !state.diceRolled || state.pendingDice.length === 0 || state.isTransitioning) return;
    if (!isHumanTurn(state)) return;
    if (getValidMovesForAnyDice(state.tokens, getCurrentPlayer(state), state.pendingDice).length === 0) {
      const t = setTimeout(() => handleNoMoves(), 1000); return () => clearTimeout(t);
    }
  }, [gameState?.diceRolled, gameState?.pendingDice.length, gameState?.isTransitioning]);

  // ─── Online Game Actions ────────────────────────────────────────────────

  const onlineRollDice = useCallback(() => {
    if (!socket || !roomInfo || !onlineGameState) return;
    const cp = getCurrentPlayer(onlineGameState);
    if (myColor !== cp || onlineGameState.diceRolled) return;
    socket.emit('roll-dice', { roomId: roomInfo.id });
  }, [socket, roomInfo, onlineGameState, myColor]);

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



  // ─── Render Screens ────────────────────────────────────────────────────

  if (screen === 'start') {
    return <StartScreen onLocal={() => setScreen('options')} onOnline={() => setScreen('online-login')} />;
  }

  if (screen === 'options') {
    return <OptionsScreen onStart={(options, pc) => {
      const players: PlayerColor[] = ['green','yellow','red','blue'].slice(0, pc) as PlayerColor[];
      setGameState(createInitialState(players, options));
      setScreen('game');
    }} onBack={() => setScreen('start')} />;
  }

  if (screen === 'online-login') {
    return <OnlineLoginScreen onConnect={(sock, uname) => {
      setSocket(sock); setOnlineUsername(uname); setScreen('online-lobby');
    }} />;
  }

  if (screen === 'online-lobby') {
    return <OnlineLobbyScreen socket={socket!} username={onlineUsername} onlineUsers={onlineUsers} roomInfo={roomInfo} invites={invites}
      onBack={() => { socket?.disconnect(); setSocket(null); setRoomInfo(null); setInvites([]); setOnlineUsers([]); setScreen('start'); }} />;
  }

  // ─── Game Screen ────────────────────────────────────────────────────────

  if (screen === 'game') {
    const isOnline = !!onlineGameState;
    const gs = isOnline ? onlineGameState! : gameState!;

    if (!gs) { setScreen('start'); return null; }

    // Pass & Play transition
    if (!isOnline && gs.isTransitioning) {
      const player = getCurrentPlayer(gs);
      const colors = PLAYER_COLORS[player];
      const reversalMsg = gs.message.includes('reversed') ? gs.message : undefined;
      return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-4">
          <div className="text-center">
            <div className="w-24 h-24 rounded-full mx-auto mb-6 shadow-2xl flex items-center justify-center" style={{ backgroundColor: colors.bg, border: `4px solid ${colors.dark}` }}>
              <span className="text-4xl font-bold text-white">{capitalize(player).charAt(0)}</span>
            </div>
            <h2 className="text-2xl font-bold text-white mb-2">{capitalize(player)}'s Turn</h2>
            {reversalMsg && <p className="text-amber-400 text-sm mb-2 font-medium">{reversalMsg}</p>}
            <p className="text-white/50 text-sm mb-8">Pass the device to the {capitalize(player)} player</p>
            <button onClick={handleReady} className="px-8 py-3 rounded-xl text-white font-bold text-lg shadow-lg hover:scale-105 transition-transform active:scale-95" style={{ backgroundColor: colors.bg }}>I'm Ready! 👋</button>
          </div>
        </div>
      );
    }

    return <GameBoard gameState={gs} boardSize={boardSize} myColor={myColor} isOnline={isOnline} isRolling={isRolling}
      onTokenClick={isOnline ? onlineMoveToken : handleTokenClick}
      onRollDice={isOnline ? onlineRollDice : rollDice}
      onSelectDice={isOnline ? onlineSelectDice : handleSelectDice}
      onNewGame={() => {
        if (isOnline) { socket?.disconnect(); setSocket(null); setOnlineGameState(null); setRoomInfo(null); setMyColor(null); setInvites([]); }
        else { setGameState(null); }
        setScreen('start');
      }} />;
  }

  return null;
}
