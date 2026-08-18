import { useEffect, useRef, useState } from 'react';
import type { VoiceChatApi } from './voice';

// Compact voice-chat controls. Used inline in the lobby room panel and as a
// floating, shrinkable control on the online game screen so it never covers
// the roll-dice button.
export function VoicePanel({ voice, me, floating = false }: { voice: VoiceChatApi; me: string; floating?: boolean }) {
  const { status, error, muted, deafened, users, peerStates } = voice;
  const [expanded, setExpanded] = useState(!floating);
  const rootRef = useRef<HTMLDivElement>(null);

  // After voice actually starts, collapse to the mic FAB so the board stays clear.
  useEffect(() => {
    if (floating && status === 'on') setExpanded(false);
  }, [floating, status]);

  useEffect(() => {
    if (!floating || !expanded) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setExpanded(false);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [floating, expanded]);

  const liveDot = status === 'on' && !muted;
  const icon = status === 'error' ? '⚠️' : status === 'connecting' ? '⏳' : muted && status === 'on' ? '🔇' : deafened && status === 'on' ? '🙉' : '🎙️';
  const aria = status === 'on'
    ? (expanded ? 'Hide voice chat' : 'Open voice chat')
    : 'Voice chat';

  const menu = (
    <>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-bold text-white">🎙️ Voice Chat</span>
        <div className="flex items-center gap-1.5">
          {status === 'on' && (
            <span className="rounded-full bg-green-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-green-300">LIVE</span>
          )}
          {floating && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="rounded-md px-1.5 py-0.5 text-xs text-white/60 hover:bg-white/10 hover:text-white"
              aria-label="Minimize voice chat"
            >
              ▾
            </button>
          )}
        </div>
      </div>

      {status === 'off' && (
        <button
          onClick={voice.join}
          className="w-full rounded-xl bg-indigo-500 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-400"
        >
          Join Voice
        </button>
      )}

      {status === 'connecting' && (
        <div className="py-2 text-center text-xs text-white/70">Requesting microphone…</div>
      )}

      {status === 'error' && (
        <div>
          <p className="mb-2 text-xs text-red-400">{error}</p>
          <button
            onClick={voice.join}
            className="w-full rounded-xl bg-indigo-500 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-400"
          >
            Try again
          </button>
        </div>
      )}

      {status === 'on' && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => voice.setMuted(!muted)}
            className={`flex-1 rounded-lg px-2 py-2 text-xs font-semibold transition-colors ${
              muted ? 'bg-amber-500/80 text-amber-950' : 'bg-white/10 text-white hover:bg-white/20'
            }`}
          >
            {muted ? '🔇 Unmute' : '🎙️ Mute'}
          </button>
          <button
            onClick={() => voice.setDeafened(!deafened)}
            className={`flex-1 rounded-lg px-2 py-2 text-xs font-semibold transition-colors ${
              deafened ? 'bg-amber-500/80 text-amber-950' : 'bg-white/10 text-white hover:bg-white/20'
            }`}
          >
            {deafened ? '🔊 Undeafen' : '🙉 Deafen'}
          </button>
          <button
            onClick={voice.leave}
            className="rounded-lg bg-red-500/80 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-500"
          >
            Leave
          </button>
        </div>
      )}

      {users.length > 0 && (
        <div className="mt-2 max-h-28 space-y-1 overflow-y-auto pr-0.5">
          {users.map((u) => {
            const isMe = u.username === me;
            const dot = u.deafened
              ? 'bg-red-400'
              : u.muted
                ? 'bg-amber-400'
                : isMe
                  ? 'bg-green-400'
                  : peerStates[u.username] === 'connected'
                    ? 'bg-green-400'
                    : peerStates[u.username] === 'connecting' || peerStates[u.username] === 'new'
                      ? 'bg-yellow-400'
                      : 'bg-gray-400';
            return (
              <div key={u.username} className="flex items-center gap-2 text-xs">
                <span className={`h-2 w-2 rounded-full ${dot}`} />
                <span className="text-white/80">{u.username}{isMe ? ' (you)' : ''}</span>
                {u.muted && <span className="text-white/40">🔇</span>}
                {u.deafened && <span className="text-white/40">🙉</span>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  if (!floating) {
    return (
      <div className="w-full">
        <div className="mt-3 rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-3">
          {menu}
        </div>
      </div>
    );
  }

  // Top-right, below the header — never over the bottom roll-dice control.
  return (
    <div
      ref={rootRef}
      className="fixed z-50"
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 3.4rem)', right: '0.5rem' }}
    >
      {!expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label={aria}
          className="relative flex h-11 w-11 items-center justify-center rounded-full border border-white/25 bg-slate-900/90 text-lg shadow-xl backdrop-blur-md transition-transform hover:scale-105 active:scale-95"
        >
          <span aria-hidden>{icon}</span>
          {liveDot && (
            <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-400" />
            </span>
          )}
          {status === 'on' && users.length > 1 && (
            <span className="absolute -bottom-1 -left-1 min-w-[1rem] rounded-full bg-indigo-500 px-1 text-[9px] font-bold leading-4 text-white">
              {users.length}
            </span>
          )}
        </button>
      ) : (
        <div className="w-56 max-w-[calc(100vw-1rem)] rounded-2xl border border-white/20 bg-slate-900/90 p-3 shadow-xl backdrop-blur-md">
          {menu}
        </div>
      )}
    </div>
  );
}
