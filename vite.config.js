import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

// Serves the user's installed game folder at /game/ plus a file manifest.
// Set HP_GAME_DIR to point elsewhere (defaults to ../HarryPotter).
const GAME_DIR = path.resolve(process.env.HP_GAME_DIR || path.join(__dirname, '../HarryPotter'));
const DIRS = ['Maps', 'System', 'Textures', 'Sounds', 'Music', 'Help', 'save'];

function manifest() {
  const files = [];
  for (const d of DIRS) {
    const p = path.join(GAME_DIR, d);
    if (!fs.existsSync(p)) continue;
    for (const f of fs.readdirSync(p)) if (fs.statSync(path.join(p, f)).isFile()) files.push(`${d}/${f}`);
  }
  return files;
}

function gameFiles() {
  const handler = (req, res, next) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (!url.startsWith('/game/')) return next();
    const rel = url.slice(6);
    if (rel === 'manifest.json') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(manifest()));
    }
    const full = path.resolve(GAME_DIR, rel);
    if (!full.startsWith(GAME_DIR) || !fs.existsSync(full)) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'max-age=3600');
    fs.createReadStream(full).pipe(res);
  };
  return {
    name: 'hp-game-files',
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

export default defineConfig({
  plugins: [gameFiles()],
  server: { port: 5173, watch: { ignored: ['**/HarryPotter2/**', '**/*.zip', '**/tools/**', '**/tests/**'] } },
});
