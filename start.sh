#!/usr/bin/env bash
# Rally Raid — lancement en 1 clic (Linux / macOS)
# Vérifie Node.js (propose l'installation si absent), démarre le serveur
# autoritaire puis ouvre le navigateur sur le poste de stratège.
set -u
cd "$(dirname "$0")"
URL="http://localhost:8787"

have_node() { command -v node >/dev/null 2>&1; }

node_ok() { node -e 'const m=process.version.match(/v(\d+)\.(\d+)/); process.exit(+m[1]>22||( +m[1]===22&&+m[2]>=6)?0:1)' 2>/dev/null; }

if ! have_node || ! node_ok; then
  echo "Node.js >= 22.6 requis mais introuvable."
  echo "Installation automatique ?"
  select_yn() {
    printf "Installer maintenant ? [o/N] "; read -r r
    case "$r" in o|O|y|Y) return 0;; *) return 1;; esac
  }
  if select_yn; then
    if command -v apt-get >/dev/null 2>&1; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
    elif command -v brew >/dev/null 2>&1; then
      brew install node@22
    else
      echo "Gestionnaire non détecté — installe Node.js >= 22.6 : https://nodejs.org"
      exit 1
    fi
    hash -r
    if ! have_node; then
      echo "Node installé mais non accessible — rouvre un terminal et relance."
      exit 1
    fi
  else
    exit 1
  fi
fi

echo "Démarrage du serveur Rally Raid..."
node --experimental-strip-types server/server.ts &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT INT TERM

up=false
for _ in $(seq 1 30); do
  sleep 1
  if node -e "fetch('$URL/api/health').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then
    up=true; break
  fi
done

if $up; then
  echo "Serveur prêt — ouverture du navigateur..."
  (command -v xdg-open >/dev/null && xdg-open "$URL") ||
    (command -v open >/dev/null && open "$URL") ||
    echo "Ouvre manuellement : $URL"
  echo "Ctrl+C pour arrêter."
  wait $SERVER_PID
else
  echo "Le serveur ne répond pas — vérifie les messages ci-dessus."
  exit 1
fi
