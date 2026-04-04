# SwarLok
A MUSIC WEBSITE

## Backend endpoints expected by frontend

- `POST /api/import/local-json`
  Accepts JSON body: `{ "tracks": [{ id, name, artist, mime, duration, size, dataUrl }] }` and stores uploaded tracks.
- `POST /api/import/spotify`
  Accepts JSON body: `{ "playlistUrl": "https://open.spotify.com/playlist/..." }` and returns normalized tracks/playlist data.

An example Cloudflare Worker backend is included at `backend/worker.js`.
