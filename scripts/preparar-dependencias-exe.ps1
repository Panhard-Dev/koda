param(
  [string]$Destino = 'C:\Users\panhard\Desktop\dependencias'
)

$ErrorActionPreference = 'Stop'
$raiz = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
New-Item -ItemType Directory -Path $Destino -Force | Out-Null

function CopiarArquivo([string]$Origem, [string]$Alvo) {
  if (-not (Test-Path -LiteralPath $Origem -PathType Leaf)) { throw "Arquivo ausente: $Origem" }
  New-Item -ItemType Directory -Path (Split-Path $Alvo) -Force | Out-Null
  Copy-Item -LiteralPath $Origem -Destination $Alvo -Force
}

function CopiarPasta([string]$Origem, [string]$Alvo) {
  if (-not (Test-Path -LiteralPath $Origem -PathType Container)) { throw "Pasta ausente: $Origem" }
  New-Item -ItemType Directory -Path $Alvo -Force | Out-Null
  Copy-Item -Path (Join-Path $Origem '*') -Destination $Alvo -Recurse -Force
}

CopiarArquivo (Join-Path $raiz 'LizProxy.py') (Join-Path $Destino 'LizProxy.py')
CopiarPasta (Join-Path $raiz 'src-tauri/runtime/backend') (Join-Path $Destino 'runtime/backend')
CopiarPasta (Join-Path $raiz 'src-tauri/runtime/node') (Join-Path $Destino 'runtime/node')
CopiarPasta (Join-Path $raiz 'node_modules') (Join-Path $Destino 'build-local/node_modules')
CopiarPasta (Join-Path $raiz 'backend/.venv') (Join-Path $Destino 'build-local/backend-venv')
CopiarPasta (Join-Path $raiz 'mcp') (Join-Path $Destino 'mcp')
CopiarPasta (Join-Path $raiz 'skills') (Join-Path $Destino 'skills')

$json = @(
  'mcp/mcps.json',
  'skills/skills.json',
  'backend/app/provedores_koda.json',
  'backend/app/provedores_oauth.json',
  'src-tauri/tauri.conf.json'
)
foreach ($arquivo in $json) {
  $nome = ($arquivo -replace '/', '_')
  CopiarArquivo (Join-Path $raiz $arquivo) (Join-Path $Destino "json/$nome")
}

$manifestos = @(
  'package.json', 'package-lock.json', 'backend/pyproject.toml',
  'backend/requirements.txt', 'backend/uv.lock',
  'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'
)
foreach ($arquivo in $manifestos) {
  $nome = ($arquivo -replace '/', '_')
  CopiarArquivo (Join-Path $raiz $arquivo) (Join-Path $Destino "manifestos/$nome")
}

CopiarArquivo (Join-Path $raiz 'docs/DEPENDENCIAS-EXE.md') (Join-Path $Destino 'MANUAL.md')
CopiarArquivo (Join-Path $raiz 'docs/COMO-GERAR-INSTALADORES-2026-10-23.md') (Join-Path $Destino 'COMO-GERAR-INSTALADORES-2026-10-23.md')
CopiarArquivo (Join-Path $raiz 'backend/COMO-REFAZER-O-AMBIENTE.txt') (Join-Path $Destino 'COMO-REFAZER-O-AMBIENTE.txt')

$banco = Join-Path $Destino 'banco-limpo/koda.db'
New-Item -ItemType Directory -Path (Split-Path $banco) -Force | Out-Null
if (Test-Path -LiteralPath $banco) { Remove-Item -LiteralPath $banco -Force }
$env:KODA_BANCO_LIMPO = $banco
Push-Location $raiz
try {
  python -c "import os,sys; from pathlib import Path; sys.path.insert(0,'backend'); from app.db import Database; Database(Path(os.environ['KODA_BANCO_LIMPO'])).initialize()"
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar o banco vazio' }
} finally {
  Pop-Location
  Remove-Item Env:KODA_BANCO_LIMPO -ErrorAction SilentlyContinue
}

Write-Host "Kit de dependências preparado em $Destino"
