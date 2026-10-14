# Rally Raid - lancement en 1 clic (Windows PowerShell)
# Verifie Node.js (l installe via winget si absent), demarre le serveur
# autoritaire puis ouvre le navigateur sur le poste de stratege.
# Aucune mort silencieuse : chaque echec est LISIBLE, la fenetre
# attend une touche avant de se fermer (voir start.cmd : pause si echec).
#
# REGLE ABSOLUE de ce fichier : ASCII PUR. Windows PowerShell 5.1 lit un
# fichier sans BOM comme ANSI (CP1252) : le tiret long UTF-8 devient un
# octet 0x94 que le parseur traite comme un GUILLEMET COURBE : toutes les
# chaines se desalignent et le fichier entier casse. pwsh 7 lit en UTF-8 :
# la CI ne voit rien. D ou le controle ASCII ajoute dans la CI. En plus :
# chaines en doubles quotes uniquement, ZERO apostrophe dans les textes.

$ErrorActionPreference = "Stop"
$url = "http://localhost:8787"

function Test-Node {
  # presence ET version : Node < 22.6 plante le serveur silencieusement
  # (les types .ts ne seraient pas stripes). Get-Command evite le piege
  # PowerShell 5.1 : le stderr d une commande native + EAP Stop jette.
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
  $v = node -v
  if ($v -match "^v(\d+)\.(\d+)") {
    $maj = [int]$Matches[1]; $min = [int]$Matches[2]
    return ($maj -gt 22) -or ($maj -eq 22 -and $min -ge 6)
  }
  return $false
}

function Test-Winget {
  # winget n est pas present sur tout Windows (versions anciennes,
  # certaines editions d entreprise) - le verifier AVANT d appeler,
  # sinon erreur rouge incomprehensible.
  return [bool](Get-Command winget -ErrorAction SilentlyContinue)
}

function Fail {
  # echec explicite : message rouge, attente d une touche, exit 1
  # (start.cmd marque l echec et fait pause - fenetre jamais instantanee)
  param([string]$Msg)
  Write-Host $Msg -ForegroundColor Red
  Read-Host "Appuie sur Entree pour fermer"
  exit 1
}

try {
  $hadNode = [bool](Get-Command node -ErrorAction SilentlyContinue)

  if (-not (Test-Node)) {
    if (-not (Test-Winget)) {
      Fail "winget indisponible - installe Node.js >= 22.6 manuellement : https://nodejs.org"
    }
    if ($hadNode) {
      # Node present mais TROP VIEUX : mise a jour proposee
      Write-Host "Node.js >= 22.6 requis (version actuelle : $(node -v))" -ForegroundColor Yellow
      Write-Host "Mise a jour via winget..." -ForegroundColor Yellow
      winget upgrade --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
      if ($LASTEXITCODE -ne 0) {
        winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
      }
      $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
      if (-not (Test-Node)) {
        Fail "Node.js toujours < 22.6 - mets a jour manuellement : https://nodejs.org"
      }
    } else {
      Write-Host "Node.js absent - installation via winget..." -ForegroundColor Yellow
      winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
      if ($LASTEXITCODE -ne 0) {
        Fail "Echec de winget. Installe Node.js manuellement : https://nodejs.org"
      }
      # recharger le PATH de la session courante
      $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
      if (-not (Test-Node)) {
        Fail "Node installe mais pas accessible - ferme et relance ce script."
      }
    }
  }

  Write-Host "Demarrage du serveur Rally Raid..." -ForegroundColor Green
  $proc = Start-Process -FilePath "node" -ArgumentList "--experimental-strip-types", "server/server.ts" -WorkingDirectory $PSScriptRoot -PassThru -WindowStyle Minimized

  # attendre que l API reponde (max 30 s)
  $up = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    # le serveur a plante au demarrage ? Ne pas attendre 30 s pour
    # dire qu il ne repond pas - expliquer la cause la plus frequente.
    if ($proc.HasExited) {
      Fail "Le serveur a plante au lancement. Cause frequente : un ancien serveur occupe deja le port 8787 - ferme les processus node (gestionnaire des taches) et relance. Pour voir le detail : ouvre une console et lance node --experimental-strip-types server/server.ts"
    }
    try {
      Invoke-WebRequest -Uri "$url/api/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
      $up = $true
      break
    } catch {}
  }

  if ($up) {
    Write-Host "Serveur pret - ouverture du navigateur..." -ForegroundColor Green
    Start-Process $url
    Write-Host "Le serveur tourne en arriere-plan (fenetre Node minimisee)." -ForegroundColor Cyan
    Write-Host "Pour arreter : ferme la fenetre Node, ou taskkill /im node.exe."
  } else {
    Fail "Le serveur ne repond pas - verifie la fenetre Node minimisee."
  }
} catch {
  # filet de securite global : plus JAMAIS de mort silencieuse
  Write-Host "ERREUR : $($_.Exception.Message)" -ForegroundColor Red
  Read-Host "Appuie sur Entree pour fermer"
  exit 1
}
