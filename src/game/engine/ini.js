// Minimal UE1 INI parser: { Section: { Key: Value } }; repeated keys become "Key[n]" style entries.
export function parseIni(text) {
  const out = {};
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { cur = out[sec[1]] ??= {}; continue; }
    if (!cur) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k in cur) { let n = 1; while (`${k}#${n}` in cur) n++; k = `${k}#${n}`; }
    cur[k] = v;
  }
  return out;
}
