import type { VoiceChatApi } from './voice';

// Compact voice-chat controls. Used inline in the lobby room panel and as a
// floating card on the online game screen.
export function VoicePanel({ voice, me, floating = false }: { voice: VoiceChatApi; me: string; floating?: boolean }) {
  const { status, error, muted, deafened, users, peerStates } = voice;

  const wrap = floating ? 'fixed bottom-4 right-4 z-50 w-72' : 'w-full';
  const card = floating
    ? 'rounded-2xl border border-white/20 bg-slate-900/80 p-3 shadow-xl backdrop-blur'
    : 'mt-3 rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-3';

  return (
    <div className={wrap}>
      <div className={card}>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-bold text-white">🎙️ Voice Chat</span>
          {status === 'on' && (
            <span className="rounded-full bg-green-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-green-300">LIVE</span>
          )}
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
          <div className="mt-2 space-y-1">
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
      </div>
    </div>
  );
}
