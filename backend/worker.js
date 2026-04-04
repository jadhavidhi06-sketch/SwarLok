/**
 * SwarLok backend (Cloudflare Worker style)
 * Endpoints:
 * - POST /api/import/local-json
 * - POST /api/import/spotify
 * - POST /api/jam/create
 * - POST /api/jam/join
 * - POST /api/jam/push
 * - POST /api/jam/pull
 */

const JAM_TTL_SECONDS = 60 * 60 * 24;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/api/import/local-json') {
      return handleLocalJsonImport(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/import/spotify') {
      return handleSpotifyImport(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/jam/create') {
      return handleJamCreate(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/jam/join') {
      return handleJamJoin(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/jam/push') {
      return handleJamPush(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/jam/pull') {
      return handleJamPull(request, env);
    }
    return json({ ok: false, error: 'Not found' }, 404);
  }
};

async function handleLocalJsonImport(request, env) {
  const body = await request.json().catch(() => ({}));
  const tracks = Array.isArray(body?.tracks) ? body.tracks : [];
  if (!tracks.length) return json({ ok: false, error: 'No tracks provided' }, 400);

  const stored = [];
  for (const track of tracks) {
    const id = track.id || crypto.randomUUID();
    const clean = {
      id,
      name: track.name || 'Untitled',
      artist: track.artist || 'Unknown',
      duration: track.duration || '--:--',
      size: track.size || '0B',
      mime: track.mime || 'audio/mpeg',
      sourceFolder: track.sourceFolder || 'Ungrouped',
      relativePath: track.relativePath || '',
      uploadedAt: new Date().toISOString()
    };
    await env.MUSIC_META?.put(`track:${id}`, JSON.stringify(clean));
    if (track.dataUrl && env.MUSIC_BUCKET) {
      const { bytes, contentType } = decodeDataUrl(track.dataUrl);
      const folderPrefix = toSafeFolder(clean.sourceFolder || 'Ungrouped');
      await env.MUSIC_BUCKET.put(`music/${folderPrefix}/${id}`, bytes, {
        httpMetadata: { contentType: contentType || clean.mime }
      });
    }
    stored.push(clean);
  }
  return json({ ok: true, storedCount: stored.length, tracks: stored });
}

async function handleSpotifyImport(request, env) {
  const body = await request.json().catch(() => ({}));
  const playlistUrl = String(body?.playlistUrl || '');
  if (!/^https?:\/\/open\.spotify\.com\/playlist\//i.test(playlistUrl)) {
    return json({ ok: false, error: 'Invalid Spotify playlist URL' }, 400);
  }

  const playlistId = playlistUrl.split('/playlist/')[1]?.split('?')[0] || crypto.randomUUID();
  const embedUrl = `https://open.spotify.com/embed/playlist/${playlistId}`;
  const playlistMeta = {
    id: playlistId,
    playlistUrl,
    embedUrl,
    importedAt: new Date().toISOString()
  };
  await env.MUSIC_META?.put(`playlist:${playlistId}`, JSON.stringify(playlistMeta));

  return json({
    ok: true,
    playlist: playlistMeta,
    tracks: [
      {
        id: `spotify-${playlistId}`,
        name: 'Spotify Playlist',
        artist: 'Spotify',
        embedUrl,
        duration: '--:--'
      }
    ]
  });
}

async function handleJamCreate(request, env) {
  const body = await request.json().catch(() => ({}));
  const hostName = sanitizeName(body?.hostName || 'Host');
  const code = generateJamCode();
  const memberId = crypto.randomUUID();
  const room = {
    code,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hostId: memberId,
    members: [{ id: memberId, name: hostName, ts: Date.now() }],
    queue: [],
    playback: { isPlaying: false, currentTime: 0, jamCurrentIndex: 0, trackId: null },
    chat: [],
    events: [],
    seq: 0
  };
  await putJamRoom(env, room);
  return json({ ok: true, code, memberId, room });
}

async function handleJamJoin(request, env) {
  const body = await request.json().catch(() => ({}));
  const code = sanitizeJamCode(body?.code);
  const name = sanitizeName(body?.name || 'Guest');
  if (!code) return json({ ok: false, error: 'Invalid room code' }, 400);
  const room = await getJamRoom(env, code);
  if (!room) return json({ ok: false, error: 'Room not found' }, 404);
  const memberId = crypto.randomUUID();
  room.members = (room.members || []).filter(m => Date.now() - m.ts < 60_000 * 10);
  room.members.push({ id: memberId, name, ts: Date.now() });
  room.updatedAt = Date.now();
  await putJamRoom(env, room);
  return json({ ok: true, code, memberId, room });
}

async function handleJamPush(request, env) {
  const body = await request.json().catch(() => ({}));
  const code = sanitizeJamCode(body?.code);
  const memberId = String(body?.memberId || '');
  const event = body?.event || null;
  if (!code || !memberId || !event?.type) return json({ ok: false, error: 'Missing fields' }, 400);
  const room = await getJamRoom(env, code);
  if (!room) return json({ ok: false, error: 'Room not found' }, 404);

  const now = Date.now();
  room.members = (room.members || []).map(m => m.id === memberId ? { ...m, ts: now } : m);
  if (!room.members.some(m => m.id === memberId)) {
    room.members.push({ id: memberId, name: sanitizeName(event.memberName || 'Guest'), ts: now });
  }

  room.seq = (room.seq || 0) + 1;
  const normalizedEvent = {
    id: room.seq,
    ts: now,
    memberId,
    type: event.type,
    payload: event.payload || {}
  };
  room.events = [...(room.events || []), normalizedEvent].slice(-300);

  if (event.type === 'queue' && Array.isArray(event.payload?.queue)) {
    room.queue = event.payload.queue.slice(0, 200);
  }
  if (event.type === 'playback') {
    room.playback = { ...(room.playback || {}), ...(event.payload || {}) };
  }
  if (event.type === 'chat' && event.payload?.item) {
    room.chat = [...(room.chat || []), event.payload.item].slice(-100);
  }

  room.updatedAt = now;
  await putJamRoom(env, room);
  return json({ ok: true, seq: room.seq });
}

async function handleJamPull(request, env) {
  const body = await request.json().catch(() => ({}));
  const code = sanitizeJamCode(body?.code);
  const since = Number(body?.since || 0);
  if (!code) return json({ ok: false, error: 'Invalid room code' }, 400);
  const room = await getJamRoom(env, code);
  if (!room) return json({ ok: false, error: 'Room not found' }, 404);
  const events = (room.events || []).filter(e => (e.id || 0) > since);
  return json({
    ok: true,
    room: {
      code: room.code,
      members: room.members || [],
      queue: room.queue || [],
      playback: room.playback || {},
      chat: room.chat || []
    },
    events,
    latestSeq: room.seq || 0
  });
}

async function getJamRoom(env, code) {
  const raw = await env.MUSIC_META?.get(`jam:${code}`);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function putJamRoom(env, room) {
  await env.MUSIC_META?.put(`jam:${room.code}`, JSON.stringify(room), { expirationTtl: JAM_TTL_SECONDS });
}

function sanitizeJamCode(code) {
  const cleaned = String(code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').trim();
  return cleaned || '';
}

function sanitizeName(name) {
  return String(name || 'Guest').trim().slice(0, 40) || 'Guest';
}

function generateJamCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const chunk = () => Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  return `JAM-${chunk()}-${chunk()}`;
}

function decodeDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!match) throw new Error('Invalid data URL format');
  const contentType = match[1];
  const raw = atob(match[2]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return { bytes, contentType };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function toSafeFolder(folder) {
  return String(folder || 'Ungrouped')
    .trim()
    .replace(/[^a-z0-9-_ ]/gi, '')
    .replace(/\s+/g, '_')
    .slice(0, 64) || 'Ungrouped';
}
