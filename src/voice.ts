import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

export interface VoiceUserInfo {
  username: string;
  muted: boolean;
  deafened: boolean;
}

export type VoiceStatus = 'off' | 'connecting' | 'on' | 'error';

export interface VoiceChatApi {
  status: VoiceStatus;
  error: string | null;
  muted: boolean;
  deafened: boolean;
  users: VoiceUserInfo[];
  peerStates: Record<string, string>;
  join: () => void;
  leave: () => void;
  setMuted: (muted: boolean) => void;
  setDeafened: (deafened: boolean) => void;
}

// ICE configuration. STUN is enough on most home/Wi-Fi networks; the TURN
// fallback helps players stuck behind strict/symmetric NATs (common on
// mobile/carrier data). The Open Relay credentials below are the public free
// ones — for production you should register your own free account at
// https://www.metered.ca/tools/openrelay/ and replace them here.
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

interface Signal {
  type: 'offer' | 'answer' | 'ice';
  sdp?: RTCSessionDescriptionInit | null;
  candidate?: RTCIceCandidateInit | null;
}

interface Peer {
  username: string;
  pc: RTCPeerConnection;
  // Deterministic tie-breaker for the "perfect negotiation" pattern so that
  // simultaneous offers don't cause a glare deadlock.
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
}

/**
 * Manages a WebRTC full-mesh voice session for one room. Audio flows
 * peer-to-peer; the Socket.IO server only relays signaling messages.
 */
export class VoiceManager {
  private socket: Socket;
  private roomId: string;
  private myUsername: string;
  private localStream: MediaStream | null = null;
  private peers = new Map<string, Peer>();
  private remoteAudio = new Map<string, HTMLAudioElement>();
  private muted = false;
  private deafened = false;
  private started = false;
  private connecting = false;
  private onState: (patch: Partial<VoiceChatApi>) => void;

  constructor(
    socket: Socket,
    roomId: string,
    myUsername: string,
    onState: (patch: Partial<VoiceChatApi>) => void,
  ) {
    this.socket = socket;
    this.roomId = roomId;
    this.myUsername = myUsername;
    this.onState = onState;
  }

  async start(): Promise<void> {
    if (this.started || this.connecting) return;
    this.connecting = true;
    this.onState({ status: 'connecting', error: null });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.localStream = stream;
      this.applyLocalTrackState();
      this.started = true;
      this.connecting = false;
      this.socket.emit('voice-join', { roomId: this.roomId });
      this.onState({ status: 'on', error: null });
    } catch (err) {
      this.connecting = false;
      const denied = err instanceof DOMException && err.name === 'NotAllowedError';
      this.onState({
        status: 'error',
        error: denied ? 'Microphone access was denied. Allow the mic and try again.' : 'Could not access the microphone.',
      });
    }
  }

  stop(): void {
    if (!this.started && !this.localStream) return;
    this.socket.emit('voice-leave', { roomId: this.roomId });
    this.teardown();
    this.onState({ status: 'off', users: [], peerStates: {}, muted: false, deafened: false });
  }

  private teardown(): void {
    for (const key of [...this.peers.keys()]) this.closePeer(key);
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) t.stop();
      this.localStream = null;
    }
    for (const el of this.remoteAudio.values()) {
      el.srcObject = null;
      el.remove();
    }
    this.remoteAudio.clear();
    this.started = false;
    this.connecting = false;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyLocalTrackState();
    this.socket.emit('voice-state', { roomId: this.roomId, muted, deafened: this.deafened });
    this.onState({ muted });
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    this.applyLocalTrackState();
    for (const el of this.remoteAudio.values()) el.muted = deafened;
    this.socket.emit('voice-state', { roomId: this.roomId, muted: this.muted, deafened });
    this.onState({ deafened });
  }

  private applyLocalTrackState(): void {
    if (!this.localStream) return;
    const enabled = !this.muted && !this.deafened;
    for (const t of this.localStream.getAudioTracks()) t.enabled = enabled;
  }

  // Reconcile the mesh with the current set of voice participants.
  syncPeers(usernames: string[]): void {
    if (!this.started) return;
    const desired = new Set(usernames.filter((u) => u !== this.myUsername));
    for (const name of desired) {
      if (!this.peers.has(name)) this.createPeer(name);
    }
    for (const name of [...this.peers.keys()]) {
      if (!desired.has(name)) this.closePeer(name);
    }
  }

  private createPeer(username: string): void {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer: Peer = {
      username,
      pc,
      polite: this.myUsername < username,
      makingOffer: false,
      ignoreOffer: false,
    };
    this.peers.set(username, peer);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.sendSignal(username, { type: 'ice', candidate: candidate.toJSON() });
    };
    pc.ontrack = (ev) => {
      if (ev.streams && ev.streams[0]) this.attachAudio(username, ev.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      this.onState({ peerStates: { [username]: pc.connectionState } });
    };
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) {
          this.sendSignal(username, {
            type: 'offer',
            sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
          });
        }
      } catch (err) {
        console.error('voice negotiation error', err);
      } finally {
        peer.makingOffer = false;
      }
    };

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    }
  }

  private closePeer(username: string): void {
    const peer = this.peers.get(username);
    if (!peer) return;
    this.peers.delete(username);
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.onconnectionstatechange = null;
    try { peer.pc.close(); } catch { /* noop */ }
    const el = this.remoteAudio.get(username);
    if (el) { el.srcObject = null; el.remove(); this.remoteAudio.delete(username); }
    this.onState({ peerStates: { [username]: 'closed' } });
  }

  handleSignal(from: string, signal: Signal): void {
    const peer = this.peers.get(from);
    if (!peer || !this.started) return;
    const { pc } = peer;
    (async () => {
      try {
        if (signal.type === 'offer' && signal.sdp) {
          // Perfect-negotiation glare handling.
          const readyForOffer = !peer.makingOffer && (pc.signalingState === 'stable' || peer.ignoreOffer);
          const offerCollision = !readyForOffer;
          peer.ignoreOffer = !peer.polite && offerCollision;
          if (peer.ignoreOffer) return;
          await pc.setRemoteDescription(signal.sdp);
          await pc.setLocalDescription();
          if (pc.localDescription) {
            this.sendSignal(from, {
              type: 'answer',
              sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
            });
          }
        } else if (signal.type === 'answer' && signal.sdp) {
          await pc.setRemoteDescription(signal.sdp);
        } else if (signal.type === 'ice' && signal.candidate) {
          try {
            await pc.addIceCandidate(signal.candidate);
          } catch (err) {
            if (!peer.ignoreOffer) console.error('addIceCandidate failed', err);
          }
        }
      } catch (err) {
        console.error('voice signal handling error', err);
      }
    })();
  }

  private sendSignal(to: string, signal: Signal): void {
    this.socket.emit('voice-signal', { roomId: this.roomId, to, signal });
  }

  private attachAudio(username: string, stream: MediaStream): void {
    let el = this.remoteAudio.get(username);
    if (!el) {
      el = document.createElement('audio');
      el.autoplay = true;
      el.muted = this.deafened;
      el.style.display = 'none';
      document.body.appendChild(el);
      this.remoteAudio.set(username, el);
    }
    el.srcObject = stream;
    el.play().catch(() => { /* autoplay may be blocked until the user interacts */ });
  }
}

export function useVoiceChat(opts: {
  socket: Socket | null;
  roomId: string | null;
  username: string;
}): VoiceChatApi {
  const { socket, roomId, username } = opts;
  const managerRef = useRef<VoiceManager | null>(null);
  const [state, setState] = useState<VoiceChatApi>({
    status: 'off',
    error: null,
    muted: false,
    deafened: false,
    users: [],
    peerStates: {},
    join: () => {},
    leave: () => {},
    setMuted: () => {},
    setDeafened: () => {},
  });

  const patch = useCallback((p: Partial<VoiceChatApi>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  // Attach Socket.IO listeners for signaling and participant state.
  useEffect(() => {
    if (!socket) return;
    const onVoiceUsers = (data: { users: VoiceUserInfo[] }) => {
      const users = data.users || [];
      setState((s) => ({ ...s, users }));
      managerRef.current?.syncPeers(users.map((u) => u.username));
    };
    const onVoiceSignal = (data: { from: string; signal: Signal }) => {
      managerRef.current?.handleSignal(data.from, data.signal);
    };
    const onVoiceReset = () => {
      managerRef.current?.stop();
    };
    socket.on('voice-users', onVoiceUsers);
    socket.on('voice-signal', onVoiceSignal);
    socket.on('voice-reset', onVoiceReset);
    return () => {
      socket.off('voice-users', onVoiceUsers);
      socket.off('voice-signal', onVoiceSignal);
      socket.off('voice-reset', onVoiceReset);
    };
  }, [socket]);

  // (Re)build the manager whenever the room or identity changes.
  useEffect(() => {
    if (socket && roomId) {
      managerRef.current?.stop();
      const manager = new VoiceManager(socket, roomId, username, patch);
      managerRef.current = manager;
      return () => {
        manager.stop();
        managerRef.current = null;
      };
    }
    managerRef.current?.stop();
    managerRef.current = null;
    setState((s) => ({ ...s, status: 'off', users: [], peerStates: {}, muted: false, deafened: false, error: null }));
  }, [socket, roomId, username, patch]);

  const join = useCallback(() => { managerRef.current?.start(); }, []);
  const leave = useCallback(() => { managerRef.current?.stop(); }, []);
  const setMuted = useCallback((m: boolean) => { managerRef.current?.setMuted(m); }, []);
  const setDeafened = useCallback((d: boolean) => { managerRef.current?.setDeafened(d); }, []);

  return { ...state, join, leave, setMuted, setDeafened };
}
