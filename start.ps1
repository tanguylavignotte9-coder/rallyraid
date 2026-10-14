# Rally Raid — lancement en 1 clic (Windows PowerShell)
# Vérifie Node.js (l'installe via winget si absent), démarre le serveur
# autoritaire puis ouvre le navigateur sur le poste de stratège.

$ErrorActionPreference = "Stop"
$url = "http://localhost:8787"

function Test-Node {
  # présence ET version : Node < 22.6 plante le serveur silencieusement
  # (les types .ts ne seraient pas stripés) — le launcher dirait
  # « ne répond pas » sans expliquer pourquoi.
  try {
    $v = node -v 2>$null
    if (-not $v) { return $false }
    if ($v -match '^v(\d+)\.(\d+)') {
      $maj = [int]$Matches[1]; $min = [int]$Matches[2]
      return ($maj -gt 22) -or ($maj -eq 22 -and $min -ge 6)
    }
    return $false
  } catch { return $false }
}

function Update-Node {
  # proposition de mise à jour via winget (même chemin que l'absence)
  Write-Host "Node.js >= 22.6 requis (version actuelle : $(node -v))" -ForegroundColor Yellow
  Write-Host "Mise a jour via winget..." -ForegroundColor Yellow
  winget upgrade --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) {
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  }
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}

$hadNode = $false
try { $hadNode = [bool](node -v 2>$null) } catch { $hadNode = $false }
if (-not (Test-Node)) {
  if ($hadNode) {
    # Node présent mais TROP VIEUX : mise à jour proposée
    Update-Node
    if (-not (Test-Node)) {
      Write-Host "Node.js toujours < 22.6 — mets a jour manuellement : https://nodejs.org" -ForegroundColor Red
      Read-Host "Appuie sur Entree pour fermer"
      exit 1
    }
  } else {
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
}

Write-Host "Demarrage du serveur Rally Raid..." -ForegroundColor Green
$proc = Start-Process -FilePath "node" -ArgumentList "--experimental-strip-types", "server/server.ts" -WorkingDirectory $PSScriptRoot -PassThru -WindowStyle Minimized

# attendre que l'API reponde (max 30 s)
$up = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    Invoke-WebRequest -Uri "$url/api/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
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
