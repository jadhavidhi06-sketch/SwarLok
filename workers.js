/**
 * SwarLok backend (Cloudflare Worker style)
 * Endpoints:
 * - POST /api/auth/register
 * - POST /api/auth/login
 * - POST /api/import/local-json
 * - POST /api/import/spotify
 * - POST /api/jam/create
 * - POST /api/jam/join
 * - POST /api/jam/invite/create
 * - POST /api/jam/invite/resolve
 * - POST /api/jam/push
 * - POST /api/jam/pull
 */

const JAM_TTL_SECONDS = 60 * 60 * 24;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }

    // 2. API routes first
    if (url.pathname.startsWith("/api/")) {
      if (request.method === 'POST' && url.pathname === '/api/auth/register') {
        return handleAuthRegister(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        return handleAuthLogin(request, env);
      }
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
      if (request.method === 'POST' && url.pathname === '/api/jam/invite/create') {
        return handleJamInviteCreate(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/jam/invite/resolve') {
        return handleJamInviteResolve(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/jam/push') {
        return handleJamPush(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/jam/pull') {
        return handleJamPull(request, env);
      }
      return json({ ok: false, error: 'API route not found' }, 404);
    }

    if (url.pathname === '/favicon.ico') {
      return new Response('', { status: 204 });
    }

    // 3. Static assets
    if (url.pathname.includes(".")) {
      return env.ASSETS.fetch(request);
    }

    // 4. SPA fallback -> index.html
    const landingPage = new URL("/index.html", request.url);
    return env.ASSETS.fetch(new Request(landingPage, request));
  }
};

async function handleAuthRegister(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = normalizeEmail(body?.email);
  const name = sanitizeName(body?.name || email.split('@')[0] || 'SoundSeeker');
  const password = String(body?.password || '');

  if (!isValidEmail(email)) {
    return json({ ok: false, error: 'Please enter a valid email address' }, 400);
  }
  const passwordValidation = validatePassword(password);
  if (!passwordValidation.ok) {
    return json({ ok: false, error: passwordValidation.error }, 400);
  }

  const key = authUserKey(email);
  const existing = await env.MUSIC_META?.get(key);
  if (existing) {
    return json({ ok: false, error: 'Account already exists for this email' }, 409);
  }

  const passwordSalt = crypto.randomUUID().replace(/-/g, '');
  const passwordHash = await hashPassword(password, passwordSalt);
  const now = new Date().toISOString();
  const userRecord = {
    email,
    name,
    passwordSalt,
    passwordHash,
    createdAt: now,
    updatedAt: now
  };
  await env.MUSIC_META?.put(key, JSON.stringify(userRecord));

  return json({
    ok: true,
    user: {
      email,
      name,
      createdAt: now
    }
  });
}

async function handleAuthLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = normalizeEmail(body?.email);
  const password = String(body?.password || '');

  if (!isValidEmail(email) || !password) {
    return json({ ok: false, error: 'Invalid credentials' }, 401);
  }

  const key = authUserKey(email);
  const raw = await env.MUSIC_META?.get(key);
  if (!raw) {
    return json({ ok: false, error: 'Invalid credentials' }, 401);
  }

  const userRecord = JSON.parse(raw);
  const expectedHash = String(userRecord?.passwordHash || '');
  const salt = String(userRecord?.passwordSalt || '');
  const providedHash = await hashPassword(password, salt);
  const isMatch = timingSafeEqual(expectedHash, providedHash);
  if (!isMatch) {
    return json({ ok: false, error: 'Invalid credentials' }, 401);
  }

  return json({
    ok: true,
    user: {
      email: userRecord.email,
      name: userRecord.name,
      createdAt: userRecord.createdAt,
      updatedAt: userRecord.updatedAt
    }
  });
}

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
  const playlistInput = String(body?.playlistUrl || '').trim();
  const playlistId = extractSpotifyPlaylistId(playlistInput);
  if (!playlistId) {
    return json({ ok: false, error: 'Invalid Spotify playlist URL' }, 400);
  }

  const playlistUrl = `https://open.spotify.com/playlist/${playlistId}`;
  const embedUrl = `https://open.spotify.com/embed/playlist/${playlistId}`;
  const remoteMeta = await fetchSpotifyPlaylistMeta(playlistId);
  const playlistMeta = {
    id: playlistId,
    playlistUrl,
    embedUrl,
    name: remoteMeta?.name || 'Spotify Playlist',
    author: remoteMeta?.author || 'Spotify',
    importedAt: new Date().toISOString()
  };
  await env.MUSIC_META?.put(`playlist:${playlistId}`, JSON.stringify(playlistMeta));

  return json({
    ok: true,
    playlist: playlistMeta,
    tracks: [
      {
        id: `spotify-${playlistId}`,
        name: playlistMeta.name,
        artist: playlistMeta.author,
        embedUrl,
        duration: '--:--'
      }
    ]
  });
}

async function handleJamCreate(request, env) {
  const body = await request.json().catch(() => ({}));
  const hostName = sanitizeName(body?.hostName || 'Host');
  const requestedCode = sanitizeJamCode(body?.code);
  const code = requestedCode || generateJamCode();
  const existing = await getJamRoom(env, code);
  if (existing) {
    return json({ ok: false, error: 'Room code already exists' }, 409);
  }
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
  const createIfMissing = Boolean(body?.createIfMissing);
  if (!code) return json({ ok: false, error: 'Invalid room code' }, 400);
  let room = await getJamRoom(env, code);
  if (!room && createIfMissing) {
    const memberId = crypto.randomUUID();
    room = {
      code,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hostId: memberId,
      members: [{ id: memberId, name, ts: Date.now() }],
      queue: [],
      playback: { isPlaying: false, currentTime: 0, jamCurrentIndex: 0, trackId: null },
      chat: [],
      events: [],
      seq: 0
    };
    await putJamRoom(env, room);
    return json({ ok: true, code, memberId, room, created: true });
  }
  if (!room) return json({ ok: false, error: 'Room not found' }, 404);
  const memberId = crypto.randomUUID();
  room.members = (room.members || []).filter(m => Date.now() - m.ts < 60_000 * 10);
  room.members.push({ id: memberId, name, ts: Date.now() });
  room.updatedAt = Date.now();
  await putJamRoom(env, room);
  return json({ ok: true, code, memberId, room });
}

async function handleJamInviteCreate(request, env) {
  const body = await request.json().catch(() => ({}));
  const code = sanitizeJamCode(body?.code);
  const createdByMemberId = String(body?.memberId || '').trim();
  const createdByName = sanitizeName(body?.name || 'Host');
  const expiresInMinutes = Math.min(Math.max(Number(body?.expiresInMinutes || 120), 5), 60 * 24 * 7);
  if (!code) return json({ ok: false, error: 'Invalid room code' }, 400);

  const room = await getJamRoom(env, code);
  if (!room) return json({ ok: false, error: 'Room not found' }, 404);

  const now = Date.now();
  const token = crypto.randomUUID().replace(/-/g, '');
  const expiresAt = now + expiresInMinutes * 60_000;
  const invite = {
    token,
    code,
    createdAt: now,
    expiresAt,
    createdByMemberId: createdByMemberId || null,
    createdByName
  };
  await putJamInvite(env, invite);
  return json({
    ok: true,
    invite: {
      token,
      code,
      expiresAt,
      createdByName,
      inviteUrl: `/` + `?invite=${token}#jam-section`
    }
  });
}

async function handleJamInviteResolve(request, env) {
  const body = await request.json().catch(() => ({}));
  const token = String(body?.token || '').trim();
  const name = sanitizeName(body?.name || 'Guest');
  if (!token) return json({ ok: false, error: 'Invite token is required' }, 400);

  const invite = await getJamInvite(env, token);
  if (!invite) return json({ ok: false, error: 'Invite not found' }, 404);
  if (Date.now() > Number(invite.expiresAt || 0)) {
    return json({ ok: false, error: 'Invite has expired' }, 410);
  }

  const code = sanitizeJamCode(invite.code);
  if (!code) return json({ ok: false, error: 'Invite is invalid' }, 400);
  const room = await getJamRoom(env, code);
  if (!room) return json({ ok: false, error: 'Room not found' }, 404);

  const memberId = crypto.randomUUID();
  room.members = (room.members || []).filter(m => Date.now() - m.ts < 60_000 * 10);
  room.members.push({ id: memberId, name, ts: Date.now() });
  room.updatedAt = Date.now();
  await putJamRoom(env, room);

  return json({
    ok: true,
    code,
    memberId,
    room,
    invite: {
      token,
      createdByName: invite.createdByName || 'Host',
      expiresAt: Number(invite.expiresAt || 0)
    }
  });
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

  if (event.type === 'queue') {
    const incomingQueue = Array.isArray(event.payload?.queue)
      ? event.payload.queue
      : Array.isArray(event.payload?.tracks)
        ? event.payload.tracks
        : null;
    if (incomingQueue) room.queue = incomingQueue.slice(0, 200);
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

async function getJamInvite(env, token) {
  const raw = await env.MUSIC_META?.get(`jam-invite:${token}`);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function putJamInvite(env, invite) {
  const ttlSeconds = Math.max(60, Math.floor((Number(invite.expiresAt || Date.now()) - Date.now()) / 1000));
  await env.MUSIC_META?.put(`jam-invite:${invite.token}`, JSON.stringify(invite), { expirationTtl: ttlSeconds });
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

function extractSpotifyPlaylistId(input) {
  if (!input) return '';
  const uriMatch = input.match(/spotify:playlist:([A-Za-z0-9]+)/i);
  if (uriMatch?.[1]) return uriMatch[1];
  const urlMatch = input.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]+)/i);
  if (urlMatch?.[1]) return urlMatch[1];
  return '';
}

async function fetchSpotifyPlaylistMeta(playlistId) {
  try {
    const response = await fetch(`https://open.spotify.com/oembed?url=https://open.spotify.com/playlist/${playlistId}`);
    if (!response.ok) return null;
    const payload = await response.json();
    return {
      name: payload?.title || 'Spotify Playlist',
      author: payload?.author_name || 'Spotify'
    };
  } catch {
    return null;
  }
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
    headers: { 
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*', 
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

function toSafeFolder(folder) {
  return String(folder || 'Ungrouped')
    .trim()
    .replace(/[^a-z0-9-_ ]/gi, '')
    .replace(/\s+/g, '_')
    .slice(0, 64) || 'Ungrouped';
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 8) return { ok: false, error: 'Password must be at least 8 characters' };
  if (!/[A-Z]/.test(value)) return { ok: false, error: 'Password must include at least one uppercase letter' };
  if (!/[a-z]/.test(value)) return { ok: false, error: 'Password must include at least one lowercase letter' };
  if (!/[0-9]/.test(value)) return { ok: false, error: 'Password must include at least one number' };
  return { ok: true };
}

function authUserKey(email) {
  return `auth:user:${normalizeEmail(email)}`;
}

async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${salt}:${password}`));
  const bytes = new Uint8Array(digest);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i++) {
    result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return result === 0;
}