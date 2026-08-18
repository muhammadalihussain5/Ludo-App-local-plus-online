export type PlayerColor = 'green' | 'yellow' | 'red' | 'blue';

export interface GameOptions {
  extraRollOnEntry: boolean;
  extraTurnOnCapture: boolean;
  diceCount: 1 | 2;
  twoDiceMode: 'both' | 'choose';
  isAIMode: boolean;
}

export interface Token {
  id: number;
  player: PlayerColor;
  steps: number; // -1 = home, 0-50 = main path, 51-56 = home stretch, 56 = finished
}

export interface GameState {
  players: PlayerColor[];
  currentPlayerIndex: number;
  gameId: string;
  tokens: Token[];
  diceValues: number[];
  pendingDice: number[];
  selectedDiceIndex: number | null;
  diceRolled: boolean;
  // Winner is set only when the game actually ends (the second-last player finishes)
  winner: PlayerColor | null;
  // Order in which players finished (1st, 2nd, 3rd). The 4th place is whoever is left.
  finishedOrder: PlayerColor[];
  gameStarted: boolean;
  message: string;
  options: GameOptions;
  // True when the current player still owes themselves another roll before
  // moving (rolled a 6 with one die, or double 6 with two dice). The bonus
  // dice are accumulated first, then the player moves with the whole pool.
  pendingExtraRoll: boolean;
  // Non-empty when a post-move bonus was earned during the move phase (a
  // capture with extraTurnOnCapture, or a board entry with extraRollOnEntry).
  // Holds the human-readable reason and is granted once the pending dice are
  // exhausted.
  pendingBonusReason: string;
  isTransitioning: boolean;
  // Turn snapshot for reversal
  turnSnapshot: Token[];
  // Consecutive sixes tracking
  consecutiveSixes: number;       // 1-die: counts consecutive 6s; 2-dice: counts consecutive double-6s
  // Whether the current roll had a 6 (for "choose" mode override)
  rollHasSix: boolean;
  captureCounts: Record<PlayerColor, number>;
  // The current player's OWN token keys (`${player}-${id}`) that could have
  // captured an opponent when the move phase began. If the player ends the
  // turn without capturing, any of these still on the board are sent home
  // (the missed-capture penalty).
  missedCaptureTargets: string[];
  // True if the current player captured at least once during this move phase.
  // Taking a real capture cancels the missed-capture penalty.
  capturedThisTurn: boolean;
}

export const PLAYER_COLORS: Record<PlayerColor, { bg: string; light: string; dark: string; text: string; border: string }> = {
  green: { bg: '#4CAF50', light: '#A5D6A7', dark: '#2E7D32', text: '#1B5E20', border: '#388E3C' },
  yellow: { bg: '#FFEB3B', light: '#FFF59D', dark: '#F9A825', text: '#F57F17', border: '#FBC02D' },
  red: { bg: '#F44336', light: '#EF9A9A', dark: '#C62828', text: '#B71C1C', border: '#D32F2F' },
  blue: { bg: '#2196F3', light: '#90CAF9', dark: '#1565C0', text: '#0D47A1', border: '#1976D2' },
};

export const MAIN_PATH: [number, number][] = [
  [6,1], [6,2], [6,3], [6,4], [6,5],
  [5,6], [4,6], [3,6], [2,6], [1,6], [0,6],
  [0,7], [0,8],
  [1,8], [2,8], [3,8], [4,8], [5,8],
  [6,9], [6,10], [6,11], [6,12], [6,13], [6,14],
  [7,14], [8,14],
  [8,13], [8,12], [8,11], [8,10], [8,9],
  [9,8], [10,8], [11,8], [12,8], [13,8], [14,8],
  [14,7], [14,6],
  [13,6], [12,6], [11,6], [10,6], [9,6],
  [8,5], [8,4], [8,3], [8,2], [8,1], [8,0],
  [7,0], [6,0],
];

export const HOME_STRETCHES: Record<PlayerColor, [number, number][]> = {
  green: [[7,1], [7,2], [7,3], [7,4], [7,5], [7,6]],
  yellow: [[1,7], [2,7], [3,7], [4,7], [5,7], [6,7]],
  red: [[7,13], [7,12], [7,11], [7,10], [7,9], [7,8]],
  blue: [[13,7], [12,7], [11,7], [10,7], [9,7], [8,7]],
};

export const START_INDICES: Record<PlayerColor, number> = {
  green: 0,
  yellow: 13,
  red: 26,
  blue: 39,
};

export const SAFE_POSITIONS = [0, 8, 13, 21, 26, 34, 39, 47];

export const HOME_BASE_POSITIONS: Record<PlayerColor, [number, number][]> = {
  green: [[2,2], [2,3], [3,2], [3,3]],
  yellow: [[2,11], [2,12], [3,11], [3,12]],
  red: [[11,2], [11,3], [12,2], [12,3]],
  blue: [[11,11], [11,12], [12,11], [12,12]],
};

export const HOME_BASE_INNER: Record<PlayerColor, { r1: number; r2: number; c1: number; c2: number }> = {
  green: { r1: 1, r2: 4, c1: 1, c2: 4 },
  yellow: { r1: 1, r2: 4, c1: 10, c2: 13 },
  red: { r1: 10, r2: 13, c1: 1, c2: 4 },
  blue: { r1: 10, r2: 13, c1: 10, c2: 13 },
};

export function createEmptyCaptureCounts(): Record<PlayerColor, number> {
  return { green: 0, yellow: 0, red: 0, blue: 0 };
}

const pathLookup = new Map<string, number>();
MAIN_PATH.forEach(([r, c], idx) => { pathLookup.set(`${r},${c}`, idx); });

const homeStretchLookup = new Map<string, { color: PlayerColor; hsIndex: number }>();
(Object.entries(HOME_STRETCHES) as [PlayerColor, [number, number][]][]).forEach(([color, positions]) => {
  positions.forEach(([r, c], idx) => { homeStretchLookup.set(`${r},${c}`, { color, hsIndex: idx }); });
});

export function getCellInfo(r: number, c: number): {
  type: 'homeBase' | 'homeBaseInner' | 'path' | 'homeStretch' | 'center' | 'empty';
  color?: PlayerColor;
  pathIndex?: number;
  hsIndex?: number;
  isSafe?: boolean;
  isStart?: boolean;
} {
  if (r <= 5 && c <= 5) {
    const inner = HOME_BASE_INNER.green;
    if (r >= inner.r1 && r <= inner.r2 && c >= inner.c1 && c <= inner.c2)
      return { type: 'homeBaseInner', color: 'green' };
    return { type: 'homeBase', color: 'green' };
  }
  if (r <= 5 && c >= 9) {
    const inner = HOME_BASE_INNER.yellow;
    if (r >= inner.r1 && r <= inner.r2 && c >= inner.c1 && c <= inner.c2)
      return { type: 'homeBaseInner', color: 'yellow' };
    return { type: 'homeBase', color: 'yellow' };
  }
  if (r >= 9 && c <= 5) {
    const inner = HOME_BASE_INNER.red;
    if (r >= inner.r1 && r <= inner.r2 && c >= inner.c1 && c <= inner.c2)
      return { type: 'homeBaseInner', color: 'red' };
    return { type: 'homeBase', color: 'red' };
  }
  if (r >= 9 && c >= 9) {
    const inner = HOME_BASE_INNER.blue;
    if (r >= inner.r1 && r <= inner.r2 && c >= inner.c1 && c <= inner.c2)
      return { type: 'homeBaseInner', color: 'blue' };
    return { type: 'homeBase', color: 'blue' };
  }
  if (r >= 6 && r <= 8 && c >= 6 && c <= 8) return { type: 'center' };

  const pathIdx = pathLookup.get(`${r},${c}`);
  if (pathIdx !== undefined) {
    return { type: 'path', pathIndex: pathIdx, isSafe: SAFE_POSITIONS.includes(pathIdx), isStart: Object.values(START_INDICES).includes(pathIdx) };
  }
  const hsInfo = homeStretchLookup.get(`${r},${c}`);
  if (hsInfo) return { type: 'homeStretch', color: hsInfo.color, hsIndex: hsInfo.hsIndex };

  return { type: 'empty' };
}

export function getTokenPosition(token: Token): [number, number] {
  if (token.steps === -1) return HOME_BASE_POSITIONS[token.player][token.id];
  if (token.steps >= 0 && token.steps <= 50) return MAIN_PATH[(START_INDICES[token.player] + token.steps) % 52];
  if (token.steps >= 51 && token.steps <= 56) return HOME_STRETCHES[token.player][token.steps - 51];
  return [7, 7];
}

export function isSafePosition(pathIndex: number): boolean {
  return SAFE_POSITIONS.includes(pathIndex);
}

export function getValidMoves(
  tokens: Token[],
  player: PlayerColor,
  diceValue: number,
  captureCounts: Record<PlayerColor, number> = createEmptyCaptureCounts(),
): Token[] {
  return tokens.filter(t => t.player === player).filter(token => {
    if (token.steps === -1) return diceValue === 6;
    if (token.steps >= 56) return false;
    if (token.steps < 51 && token.steps + diceValue > 50 && captureCounts[player] <= 0) return false;
    return token.steps + diceValue <= 56;
  });
}

export function getValidMovesForAnyDice(
  tokens: Token[],
  player: PlayerColor,
  pendingDice: number[],
  captureCounts: Record<PlayerColor, number> = createEmptyCaptureCounts(),
): Token[] {
  const seen = new Set<string>();
  const result: Token[] = [];
  for (const dv of pendingDice) {
    for (const t of getValidMoves(tokens, player, dv, captureCounts)) {
      const key = `${t.player}-${t.id}`;
      if (!seen.has(key)) { seen.add(key); result.push(t); }
    }
  }
  return result;
}

export function executeMove(tokens: Token[], token: Token, diceValue: number, captureCounts: Record<PlayerColor, number>): {
  tokens: Token[];
  captured: boolean;
  enteredBoard: boolean;
  captureCounts: Record<PlayerColor, number>;
} {
  const newTokens = tokens.map(t => ({ ...t }));
  const newCaptureCounts = { ...captureCounts };
  const movingToken = newTokens.find(t => t.id === token.id && t.player === token.player)!;
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

// ─── Mandatory capture helpers ───────────────────────────────────────────────

// Returns true if moving `token` by `diceValue` would land on an opponent's
// piece (i.e. result in a capture) AND that landing square is not a safe
// square.
export function moveWouldCapture(tokens: Token[], token: Token, diceValue: number): boolean {
  // Coming out of home base (-1) goes to start square; that's its own "entry" rule,
  // not a capture.
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

// ─── Missed-capture (mandatory capture) helpers ─────────────────────────────
//
// A capture is no longer forced on the player: every legal move is allowed.
// Instead, if a capture was possible during the turn and the player did not
// take it, the PLAYER'S OWN piece that could have captured is sent back to its
// home base (the opponent piece stays put). Detection must cover:
//   1. each individual die value,
//   2. the sum of the dice (two-dice "both" mode: one piece moving d1 + d2),
//   3. any combination/sequence of the dice applied to the same piece
//      (e.g. move d1 then d2 — the final square is the same as moving d1+d2),
// including the larger accumulated pools produced by bonus re-rolls.

// Enumerate every distinct total a piece can reach by using any non-empty
// subset of `pendingDice`. Since applying dice in any order produces the same
// final total, subset sums cover all combinations/sequences.
//
// In two-dice "choose" mode the unused die is normally discarded, so only
// individual values are reachable — UNLESS the roll contains a 6, in which
// case both dice must be used (same as "both" mode). Pass `rollHasSix` so
// detection matches that override.
export function getReachableTotals(pendingDice: number[], options?: GameOptions, rollHasSix?: boolean): number[] {
  if (options && options.diceCount === 2 && options.twoDiceMode === 'choose' && !rollHasSix) {
    return [...new Set(pendingDice)];
  }
  const counts = new Map<number, number>();
  for (const dv of pendingDice) counts.set(dv, (counts.get(dv) ?? 0) + 1);
  const unique = [...counts.keys()];
  const totals = new Set<number>();
  const rec = (i: number, sum: number) => {
    if (i === unique.length) {
      if (sum > 0) totals.add(sum);
      return;
    }
    const value = unique[i];
    const max = counts.get(value)!;
    for (let k = 0; k <= max; k++) rec(i + 1, sum + value * k);
  };
  rec(0, 0);
  return [...totals].sort((a, b) => a - b);
}

// Returns the PLAYER's OWN tokens that could capture an opponent this turn
// using any reachable total from `pendingDice`. Safe landing squares never
// count, and a piece still in its home base (steps === -1) cannot capture by
// moving out — both rules are enforced by `moveWouldCapture`.
export function getCapturableOwnTokens(
  tokens: Token[],
  player: PlayerColor,
  pendingDice: number[],
  options?: GameOptions,
  rollHasSix?: boolean,
): Token[] {
  const totals = getReachableTotals(pendingDice, options, rollHasSix);
  return tokens
    .filter(t => t.player === player)
    .filter(t => totals.some(total => moveWouldCapture(tokens, t, total)));
}

// Send home the moving player's own capturable tokens (identified by their key
// in `targetKeys`) that are still on the board. This is a penalty — it does
// not count as a capture, does not increment captureCounts, and grants no
// extra turn.
export function applyMissedCapturePenalty(
  tokens: Token[],
  player: PlayerColor,
  targetKeys: string[],
): { tokens: Token[]; removedCount: number } {
  const keys = new Set(targetKeys);
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

// Human-readable message for the missed-capture penalty.
export function formatMissedCaptureMessage(player: PlayerColor, count: number): string {
  if (count === 0) return '';
  const noun = count > 1 ? 'pieces were' : 'piece was';
  return `⚠️ Missed capture — ${capitalize(player)}'s ${noun} sent home!`;
}

export function checkWin(tokens: Token[], player: PlayerColor): boolean {
  return tokens.filter(t => t.player === player).every(t => t.steps >= 56);
}

// True if `player` has all four pieces home (steps >= 56). Used for
// ranking — the game ends when the second-last player finishes, not the 1st.
export function hasPlayerFinished(tokens: Token[], player: PlayerColor): boolean {
  return tokens.filter(t => t.player === player).every(t => t.steps >= 56);
}

// Add a player to the finished order if they have just gotten all four pieces
// home AND they aren't already in the list. Returns a new finishedOrder array.
export function registerFinishedPlayer(
  finishedOrder: PlayerColor[],
  player: PlayerColor,
  tokens: Token[],
): PlayerColor[] {
  if (finishedOrder.includes(player)) return finishedOrder;
  if (!hasPlayerFinished(tokens, player)) return finishedOrder;
  return [...finishedOrder, player];
}

// Check if a dice roll should give an extra turn
// - 1 die: rolling 6 gives extra turn
// - 2 dice: double 6 gives extra turn; single 6 does NOT give extra turn from dice
export function shouldGetExtraTurnFromDice(options: GameOptions, diceValues: number[]): boolean {
  if (options.diceCount === 1) {
    return diceValues[0] === 6;
  } else {
    // 2 dice: only double 6 gives extra turn
    return diceValues.length === 2 && diceValues[0] === 6 && diceValues[1] === 6;
  }
}

// Check if turn should be reversed
// - 1 die: 3 consecutive 6s
// - 2 dice: 2 consecutive double 6s
export function shouldReverseTurn(options: GameOptions, consecutiveSixes: number): boolean {
  if (options.diceCount === 1) {
    return consecutiveSixes >= 3;
  } else {
    return consecutiveSixes >= 2;
  }
}

// Check if a 6 is present in the dice values (for "choose" mode override)
export function rollHasSix(diceValues: number[]): boolean {
  return diceValues.some(v => v === 6);
}

// Check if roll is a double six
export function isDoubleSix(diceValues: number[]): boolean {
  return diceValues.length === 2 && diceValues[0] === 6 && diceValues[1] === 6;
}

// AI logic
export function getAIMove(
  tokens: Token[],
  player: PlayerColor,
  diceValue: number,
  captureCounts: Record<PlayerColor, number> = createEmptyCaptureCounts(),
): Token | null {
  const validMoves = getValidMoves(tokens, player, diceValue, captureCounts);
  if (validMoves.length === 0) return null;

  // Priority 1: Capture (the AI still prefers taking a real capture).
  const captureToken = validMoves.find(t => moveWouldCapture(tokens, t, diceValue));
  if (captureToken) return captureToken;

  // Priority 2: Enter home stretch or finish
  const homeStretchToken = validMoves.find(t => t.steps !== -1 && t.steps + diceValue >= 51);
  if (homeStretchToken) return homeStretchToken;

  // Priority 3: Take out of home base
  const homeToken = validMoves.find(t => t.steps === -1);
  if (homeToken && diceValue === 6) {
    const ownTokenAtStart = tokens.some(t => t.player === player && t.steps === 0);
    if (!ownTokenAtStart) return homeToken;
  }

  // Priority 4: Move furthest token
  const sorted = [...validMoves].filter(t => t.steps !== -1).sort((a, b) => b.steps - a.steps);
  if (sorted.length > 0) return sorted[0];

  if (homeToken) return homeToken;
  return validMoves[0];
}

// AI for two dice - pick best die and token
export function getAIMoveTwoDice(
  tokens: Token[],
  player: PlayerColor,
  pendingDice: number[],
  captureCounts: Record<PlayerColor, number> = createEmptyCaptureCounts(),
): { diceIndex: number; token: Token } | null {
  let bestMove: { diceIndex: number; token: Token; priority: number } | null = null;

  for (let i = 0; i < pendingDice.length; i++) {
    const dv = pendingDice[i];
    const move = getAIMove(tokens, player, dv, captureCounts);
    if (!move) continue;

    let priority = 0;
    if (move.steps === -1) {
      priority = 1; // moving out of the home base
    } else {
      const newSteps = move.steps + dv;
      if (newSteps >= 51) priority = 4; // enter home stretch / finish
      else if (moveWouldCapture(tokens, move, dv)) priority = 3; // capture
      else priority = 2; // plain move
    }

    if (!bestMove || priority > bestMove.priority) {
      bestMove = { diceIndex: i, token: move, priority };
    }
  }

  return bestMove ? { diceIndex: bestMove.diceIndex, token: bestMove.token } : null;
}

export function createInitialState(players: PlayerColor[], options: GameOptions): GameState {
  const gameId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const tokens: Token[] = [];
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
    isTransitioning: !options.isAIMode && players.length > 1,
    turnSnapshot: tokens.map(t => ({ ...t })),
    consecutiveSixes: 0,
    rollHasSix: false,
    captureCounts: createEmptyCaptureCounts(),
    missedCaptureTargets: [],
    capturedThisTurn: false,
    finishedOrder: [],
  };
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function getCurrentPlayer(state: GameState): PlayerColor {
  return state.players[state.currentPlayerIndex];
}

export function isHumanTurn(state: GameState): boolean {
  if (state.options.isAIMode) return getCurrentPlayer(state) === 'green';
  return true;
}
