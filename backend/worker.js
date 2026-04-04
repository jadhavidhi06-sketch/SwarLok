/**
 * SwarLok backend (Cloudflare Worker style)
 * Endpoints:
 * - POST /api/import/local-json
 * - POST /api/import/spotify
 *
 * Bindings expected:
 * - MUSIC_META (KV namespace)
 * - MUSIC_BUCKET (R2 bucket, optional but recommended)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/api/import/local-json') {
      return handleLocalJsonImport(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/import/spotify') {
      return handleSpotifyImport(request, env);
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
      uploadedAt: new Date().toISOString()
    };
    await env.MUSIC_META?.put(`track:${id}`, JSON.stringify(clean));
    if (track.dataUrl && env.MUSIC_BUCKET) {
      const { bytes, contentType } = decodeDataUrl(track.dataUrl);
      await env.MUSIC_BUCKET.put(`music/${id}`, bytes, {
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

  // If your private backend has Spotify API credentials, enrich this with real track previews.
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