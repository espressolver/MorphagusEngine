#!/usr/bin/env bash
# Package the web port as a fully static site (zip): the Vite build of all scripts (three.js and the MPEG
# decoder bundled in) plus exactly the game data the loader reads at run time, and game/manifest.json (the
# file list the loader uses to find packages). Unzip it anywhere under a static web server (root or a
# sub-directory) and open index.html — no server-side code, no special MIME types or rewrites needed.
#
# usage: tools/package.sh [-g GAME_DIR] [-o OUT.zip] [-l all|tra|int] [-s]
#   -s  scripts only: just index.html and assets/*.js (no game/ folder); the game data (game/ with its
#       manifest.json, from a full package) must then already be next to index.html on the server
#   -g  installed game folder (default: $HP_GAME_DIR or ../HarryPotter)
#   -o  output zip (default: hpweb-static.zip in the project folder)
#   -l  dialog/texture language to ship: tra (Chinese, the default UI language), int (English) or all
#       (default all; open the site with ?lang=int for English)
#
# Data shipped (everything else in the game folder is never fetched):
#   Maps/*.unr  System/*.u  System/*.int + language files  System/Default.ini  System/DefUser.ini
#   Textures/*.utx  Sounds/*.uax  Music/*.umx  and the *.<lang>_utx / *.<lang>_uax localized packages
# The data is your own installed copy of the game: keep the resulting site private.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GAME_DIR="${HP_GAME_DIR:-$ROOT/../HarryPotter}"
OUT="$ROOT/hpweb-static.zip"
LANG_SEL=all
SCRIPTS_ONLY=0
while getopts "g:o:l:sh" opt; do
  case "$opt" in
    g) GAME_DIR="$OPTARG" ;;
    o) OUT="$OPTARG" ;;
    l) LANG_SEL="$(printf '%s' "$OPTARG" | tr 'A-Z' 'a-z')" ;;
    s) SCRIPTS_ONLY=1 ;;
    *) sed -n '2,20p' "$0"; exit 1 ;;
  esac
done
case "$LANG_SEL" in all|tra|int) ;; *) echo "-l must be all, tra or int" >&2; exit 1 ;; esac
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
command -v zip >/dev/null || { echo "zip is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
if [ "$SCRIPTS_ONLY" = 0 ]; then
  GAME_DIR="$(cd "$GAME_DIR" && pwd)"
  for d in Maps System Textures Sounds Music; do
    [ -d "$GAME_DIR/$d" ] || { echo "not a game folder (no $d/): $GAME_DIR" >&2; exit 1; }
  done
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
SITE="$STAGE/site"

echo "== building scripts"
cd "$ROOT"
[ -d node_modules ] || npm ci
# relative base: the site works from any directory of the server
npx vite build --base ./ --outDir "$SITE" --emptyOutDir --logLevel warn

if [ "$SCRIPTS_ONLY" = 1 ]; then
  echo "== zipping scripts only"
  rm -f "$OUT"
  (cd "$SITE" && zip -qr -9 "$OUT" .)
  (cd "$SITE" && find . -type f | sed 's#^\./#   #' | sort)
  echo "done: $OUT ($(du -h "$OUT" | cut -f1))"
  echo "deploy: unzip next to an existing game/ folder (with game/manifest.json) on the server"
  exit 0
fi

# does this data file belong in the bundle?
wanted() { # folder, lower-case file name
  local d="$1" f="$2" ext="${2##*.}"
  [ "$f" = "$ext" ] && return 1
  case "$d" in
    Maps)     [ "$ext" = unr ] ;;
    Music)    [ "$ext" = umx ] ;;
    Textures|Sounds)
      case "$ext" in
        utx|uax) [ "$LANG_SEL" != tra ] || [ "$f" != alldialog.uax ] ;;  # (English dialog; tra uses AllDialog.tra_uax)
        tra_utx|tra_uax) [ "$LANG_SEL" != int ] ;;
        *) return 1 ;;
      esac ;;
    System)
      case "$f" in default.ini|defuser.ini) return 0 ;; esac
      case "$ext" in
        u|int) return 0 ;;
        tra) [ "$LANG_SEL" != int ] ;;
        *) return 1 ;;
      esac ;;
    *) return 1 ;;
  esac
}

echo "== copying game data from $GAME_DIR (language: $LANG_SEL)"
manifest=()
bytes=0
for d in Maps System Textures Sounds Music; do
  mkdir -p "$SITE/game/$d"
  while IFS= read -r -d '' f; do
    name="$(basename "$f")"
    wanted "$d" "$(printf '%s' "$name" | tr 'A-Z' 'a-z')" || continue
    cp -p "$f" "$SITE/game/$d/$name"
    manifest+=("$d/$name")
    bytes=$((bytes + $(wc -c < "$f")))
  done < <(find "$GAME_DIR/$d" -maxdepth 1 -type f -print0 | sort -z)
done

# the loader needs these by exact name
for f in System/Default.ini System/DefUser.ini System/Engine.u System/HPBase.u Maps/Lev_Tut1.unr; do
  [ -f "$SITE/game/$f" ] || { echo "missing required file: $f" >&2; exit 1; }
done

# game/manifest.json: every file the loader may fetch (names keep their case)
node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "${manifest[@]}" > "$SITE/game/manifest.json"
echo "   ${#manifest[@]} files, $((bytes / 1048576)) MB of data"

echo "== zipping"
rm -f "$OUT"
(cd "$SITE" && zip -qr -9 "$OUT" .)
echo "done: $OUT ($(du -h "$OUT" | cut -f1))"
echo "deploy: unzip into a folder served by any static web server and open .../index.html"
echo "        (start a map directly with ?map=Lev_Tut1; ?lang=int for English)"
