# Rally Raid — lancement en 1 clic (Windows PowerShell)
# Vérifie Node.js (l'installe via winget si absent), démarre le serveur
# autoritaire puis ouvre le navigateur sur le poste de stratège.

$ErrorActionPreference = "Stop"
$url = "http://localhost:8787"

function Test-Node {
  try { node --version | Out-Null; return $true } catch { return $false }
}

if (-not (Test-Node)) {
  Write-Host "Node.js absent — installation via winget..." -ForegroundColor Yellow
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Echec de winget. Installe Node.js manuellement : https://nodejs.org" -ForegroundColor Red
    Read-Host "Appuie sur Entree pour fermer"
    exit 1
  }
  # recharger le PATH de la session courante
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
  if (-not (Test-Node)) {
    Write-Host "Node installe mais pas accessible — ferme et relance ce script." -ForegroundColor Red
    Read-Host "Appuie sur Entree pour fermer"
    exit 1
  }
}

Write-Host "Demarrage du serveur Rally Raid..." -ForegroundColor Green
$proc = Start-Process -FilePath "node" -ArgumentList "--experimental-strip-types", "server/server.ts" -WorkingDirectory $PSScriptRoot -PassThru -WindowStyle Minimized

# attendre que l'API reponde (max 30 s)
$up = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    Invoke-WebRequest -Uri "$url/api/state" -UseBasicParsing -TimeoutSec 2 | Out-Null
    $up = $true
    break
  } catch {}
}

if ($up) {
  Write-Host "Serveur pret — ouverture du navigateur..." -ForegroundColor Green
  Start-Process $url
  Write-Host "Le serveur tourne en arriere-plan (fenetre Node minimisee)." -ForegroundColor Cyan
  Write-Host "Pour arreter : ferme la fenetre Node, ou lance ""Stop-RallyRaid"" (taskkill /im node.exe)."
} else {
  Write-Host "Le serveur ne repond pas — verifie la fenetre Node minimisee." -ForegroundColor Red
}
