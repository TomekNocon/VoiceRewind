type IntentMessage = {
  intent:
    | 'rewind'
    | 'forward'
    | 'set_speed'
    | 'set_volume'
    | 'pause'
    | 'play'
    | 'jump_to_phrase';
  value?: number | string;
};

const DAEMON_WS = 'ws://127.0.0.1:17321';
let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let isActiveTab = false;

function ensureOverlay() {
  if (document.getElementById('voicerewind-overlay')) return;
  const root = document.createElement('div');
  root.id = 'voicerewind-overlay';
  root.style.position = 'fixed';
  root.style.right = '12px';
  root.style.bottom = '12px';
  root.style.zIndex = '2147483647';
  root.style.fontFamily = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
  root.style.background = 'rgba(0,0,0,0.6)';
  root.style.color = '#fff';
  root.style.padding = '8px 10px';
  root.style.borderRadius = '8px';
  root.style.display = 'flex';
  root.style.gap = '8px';
  root.style.alignItems = 'center';

  const status = document.createElement('span');
  status.id = 'vr-status';
  status.textContent = '●';
  status.style.color = '#f44336';

  const active = document.createElement('span');
  active.id = 'vr-active';
  active.textContent = '(inactive)';
  active.style.opacity = '0.8';

  const btn = (label: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.background = '#121212';
    b.style.color = '#fff';
    b.style.border = '1px solid #333';
    b.style.borderRadius = '6px';
    b.style.padding = '4px 8px';
    b.style.cursor = 'pointer';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  };

  const rew = btn('⏪ 10s', () => handleIntent({ intent: 'rewind', value: 10 }));
  const fwd = btn('⏩ 10s', () => handleIntent({ intent: 'forward', value: 10 }));
  const spdDown = btn('− speed', () => {
    const v = Math.max(0.25, (getVideo()?.playbackRate ?? 1) - 0.25);
    handleIntent({ intent: 'set_speed', value: v });
  });
  const spdUp = btn('+ speed', () => {
    const v = Math.min(3, (getVideo()?.playbackRate ?? 1) + 0.25);
    handleIntent({ intent: 'set_speed', value: v });
  });

  root.append(status, active, rew, fwd, spdDown, spdUp);
  document.body.appendChild(root);
}

function setStatus(connected: boolean) {
  const el = document.getElementById('vr-status');
  if (!el) return;
  el.textContent = connected ? '●' : '○';
  (el as HTMLElement).style.color = connected ? '#4caf50' : '#f44336';
}

function setActive(active: boolean) {
  const el = document.getElementById('vr-active');
  if (!el) return;
  el.textContent = active ? '(active)' : '(inactive)';
  (el as HTMLElement).style.opacity = active ? '1' : '0.8';
}

function connect() {
  ensureOverlay();
  try {
    ws = new WebSocket(DAEMON_WS);
    ws.addEventListener('open', () => {
      console.log('[VoiceRewind] Connected to daemon');
      setStatus(true);
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as IntentMessage;
        console.log('[VoiceRewind] Received', msg);
        if (!isActiveTab) return; // only active tab handles remote intents
        handleIntent(msg);
      } catch (e) {
        console.warn('[VoiceRewind] Bad message', e);
      }
    });
    ws.addEventListener('close', () => {
      console.log('[VoiceRewind] Disconnected, retrying…');
      setStatus(false);
      scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      console.log('[VoiceRewind] WS error, retrying…');
      setStatus(false);
      scheduleReconnect();
    });
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer != null) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).visibility !== 'hidden';
}

function getVideo(): HTMLVideoElement | null {
  const candidates: HTMLVideoElement[] = [];
  const bySelector = document.querySelector('video.html5-main-video') as HTMLVideoElement | null;
  if (bySelector) candidates.push(bySelector);
  const inMoviePlayer = (document.getElementById('movie_player')?.querySelector('video') as HTMLVideoElement | null);
  if (inMoviePlayer) candidates.push(inMoviePlayer);
  candidates.push(...Array.from(document.querySelectorAll('video')));

  const unique = Array.from(new Set(candidates));
  if (unique.length === 0) return null;
  unique.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const areaA = ra.width * ra.height;
    const areaB = rb.width * rb.height;
    const visA = isVisible(a) ? 1 : 0;
    const visB = isVisible(b) ? 1 : 0;
    return visB - visA || areaB - areaA;
  });
  return unique[0] ?? null;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

async function handleIntent(msg: IntentMessage) {
  const video = getVideo();
  if (!video) {
    console.warn('[VoiceRewind] No video element found');
    return;
  }

  switch (msg.intent) {
    case 'rewind': {
      const before = video.currentTime;
      const after = clamp(before - (Number(msg.value) || 10), 0, video.duration || 1e9);
      video.currentTime = after;
      console.log('[VoiceRewind] Rewind', { before, after });
      break;
    }
    case 'forward': {
      const before = video.currentTime;
      const after = clamp(before + (Number(msg.value) || 10), 0, video.duration || 1e9);
      video.currentTime = after;
      console.log('[VoiceRewind] Forward', { before, after });
      break;
    }
    case 'set_speed': {
      const rate = clamp(Number(msg.value) || 1, 0.25, 3);
      video.playbackRate = rate;
      console.log('[VoiceRewind] Speed', rate);
      break;
    }
    case 'set_volume': {
      const vol = clamp((Number(msg.value) || 100) / 100, 0, 1);
      video.volume = vol;
      console.log('[VoiceRewind] Volume', vol);
      break;
    }
    case 'pause':
      video.pause();
      console.log('[VoiceRewind] Pause');
      break;
    case 'play':
      await video.play().catch(() => {});
      console.log('[VoiceRewind] Play');
      break;
    case 'jump_to_phrase':
      if (typeof msg.value === 'string' && msg.value.trim()) {
        const t = await findTimestampForPhrase(msg.value.trim());
        if (t != null) {
          const before = video.currentTime;
          video.currentTime = t;
          console.log('[VoiceRewind] JumpToPhrase', { before, after: t });
        } else {
          console.warn('[VoiceRewind] Phrase not found');
        }
      }
      break;
  }
}

async function findTimestampForPhrase(phrase: string): Promise<number | null> {
  const video = getVideo();
  if (!video) return null;
  const tracks = Array.from(video.textTracks || []);
  const track = tracks.find((tr) => tr.mode === 'showing') || tracks[0];
  if (!track || !track.cues) return null;
  const cues = Array.from(track.cues) as TextTrackCue[];
  const lower = phrase.toLowerCase();
  let best: { startTime: number; idx: number } | null = null;
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i] as any;
    const text: string = (cue.text || '').toString();
    if (!text) continue;
    if (text.toLowerCase().includes(lower)) {
      const s = (cue.startTime as number) ?? 0;
      if (!best || s < best.startTime) best = { startTime: s, idx: i };
    }
  }
  return best?.startTime ?? null;
}

// Background messages
window.addEventListener('message', () => {});
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'active-tab') {
    isActiveTab = true;
    setActive(true);
  }
  if (msg?.type === 'heartbeat') {
    ensureOverlay();
  }
});

// Initialize
ensureOverlay();
setStatus(false);
setActive(false);
connect(); 