// In-page driver for the naive bot: steps the bot's generator a few engine frames per rendered frame,
// so the real renderer shows the input-only playthrough (used for recordings).
import { Bot } from './bot.mjs';
import { playSteps } from './play.mjs';

export function start(engine, map, { framesPerRender = 2, verbose = false } = {}) {
  const log = s => { (window.__botLog ??= []).push(s); console.log('[bot] ' + s); };
  const bot = new Bot(engine, { headless: false, log });
  bot.verbose = verbose;
  const gen = playSteps(engine, bot, map, log);
  window.__botDone = null;
  window.__drive = () => {
    for (let i = 0; i < framesPerRender; i++) {
      const r = gen.next();
      if (r.done) { window.__botDone = r.value || {}; window.__drive = null; return; }
      if (engine.pendingTravel) { window.__botDone = { travel: engine.pendingTravel.map }; window.__drive = null; return; }
    }
  };
  return bot;
}
