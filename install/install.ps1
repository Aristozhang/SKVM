#!/usr/bin/env pwsh
<#
.SYNOPSIS
  SkVM one-liner installer for Windows.
.DESCRIPTION
  Downloads and installs the skvm binary for Windows x64.
  Usage:
    powershell -c "irm https://github.com/SJTU-IPADS/SkVM/releases/latest/download/install.ps1 | iex"

  Options (via environment):
    $env:SKVM_VERSION = "v0.1.0"   # pin a specific version (default: latest)
    $env:SKVM_PREFIX = "<dir>"      # install root (default: $env:LOCALAPPDATA\skvm)
    $env:SKVM_BIN_DIR = "<dir>"     # binary directory (default: $env:LOCALAPPDATA\Microsoft\WindowsApps)
    $env:SKVM_SKIP_OPENCODE = "1"   # skip bundled opencode (on by default for Windows)
#>

$ErrorActionPreference = "Stop"

# ------------ release host ------------
$RELEASE_OWNER = "SJTU-IPADS"
$RELEASE_REPO = "SkVM"

# ------------ download sources (auto-fallback) ------------
$DEFAULT_MIRROR_BASE = "https://skvm.oss-cn-shanghai.aliyuncs.com"
$MIRROR_RELEASES = "$DEFAULT_MIRROR_BASE/gh"
$MIRROR_API = "$DEFAULT_MIRROR_BASE/gh-api"

$SOURCE_RELEASES = @(
  @{ Name = "github"; Url = "https://github.com" },
  @{ Name = "mirror";  Url = $MIRROR_RELEASES }
)
$SOURCE_API = @(
  @{ Name = "github"; Url = "https://api.github.com" },
  @{ Name = "mirror";  Url = $MIRROR_API }
)

if ($env:SKVM_DOWNLOAD_BASE) {
  switch ($env:SKVM_DOWNLOAD_BASE) {
    "github" {
      $SOURCE_RELEASES = @(@{ Name = "github"; Url = "https://github.com" })
      $SOURCE_API = @(@{ Name = "github"; Url = "https://api.github.com" })
    }
    "mirror" {
      $SOURCE_RELEASES = @(@{ Name = "mirror"; Url = $MIRROR_RELEASES })
      $SOURCE_API = @(@{ Name = "mirror"; Url = $MIRROR_API })
    }
    default {
      $base = $env:SKVM_DOWNLOAD_BASE.TrimEnd('/')
      $SOURCE_RELEASES = @(@{ Name = "custom"; Url = "$base/gh" })
      $SOURCE_API = @(@{ Name = "custom"; Url = "$base/gh-api" })
    }
  }
}

function Fetch-WithFallback {
  param([string]$Kind, [string]$RelPath, [string]$OutFile)
  $bases = if ($Kind -eq "releases") { $SOURCE_RELEASES } elseif ($Kind -eq "api") { $SOURCE_API } else { throw "unknown kind $Kind" }
  $lastErr = $null
  foreach ($src in $bases) {
    try {
      $url = "$($src.Url)$RelPath"
      Write-Host "skvm install.ps1: fetching $url"
      if ($OutFile) {
        Invoke-WebRequest -Uri $url -OutFile $OutFile -UseBasicParsing -TimeoutSec 30
      } else {
        Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 30 | Select-Object -ExpandProperty Content
      }
      return $true
    } catch {
      $lastErr = $_
      Write-Host "  [$($src.Name)] $_; trying next source..." -ForegroundColor Yellow
    }
  }
  throw $lastErr ?? "all sources failed for $RelPath"
}

# ------------ prefix ------------
if (-not $env:SKVM_PREFIX) {
  $SKVM_PREFIX = Join-Path $env:LOCALAPPDATA "skvm"
} else {
  $SKVM_PREFIX = $env:SKVM_PREFIX
}

if (-not $env:SKVM_BIN_DIR) {
  # Use a user-writable PATH directory. LOCALAPPDATA\Microsoft\WindowsApps is
  # already on PATH for Windows 10+ users, but skvm.exe there may be confusing.
  # Instead, use LOCALAPPDATA\Programs\skvm and add it to PATH in the post-step.
  $SKVM_BIN_DIR = Join-Path $env:LOCALAPPDATA "Programs\skvm"
} else {
  $SKVM_BIN_DIR = $env:SKVM_BIN_DIR
}

# ------------ platform detection ------------
$OS = "windows"
$ARCH = if ($env:PROCESSOR_ARCHITECTURE -match "ARM64") { "arm64" } else { "x64" }
$TARGET = "$OS-$ARCH"

# ------------ resolve version ------------
if (-not $env:SKVM_VERSION) {
  $latestRel = "/repos/$RELEASE_OWNER/$RELEASE_REPO/releases/latest"
  $latestBody = Fetch-WithFallback "api" $latestRel
  $tagJson = $latestBody | ConvertFrom-Json
  $tag = $tagJson.tag_name
  if (-not $tag) { throw "failed to parse latest release tag" }
  $SKVM_VERSION = $tag
} else {
  $SKVM_VERSION = $env:SKVM_VERSION
}

$version = $SKVM_VERSION -replace '^v', ''
$tag = "v$version"
$tarballName = "skvm-$tag-$TARGET.tar.gz"
$tarballRel = "/$RELEASE_OWNER/$RELEASE_REPO/releases/download/$tag/$tarballName"

# ------------ download + verify ------------
$tmpDir = Join-Path $env:TEMP "skvm-install-$pid"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

try {
  Write-Host "skvm install.ps1: downloading $tarballName"
  $tmpTarball = Join-Path $tmpDir $tarballName
  Fetch-WithFallback "releases" $tarballRel $tmpTarball

  # Verify sha256 if available
  try {
    $shaBody = Fetch-WithFallback "releases" "$tarballRel.sha256"
    $expected = ($shaBody -split '\s+')[0]
    $actual = (Get-FileHash -Path $tmpTarball -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) {
      throw "sha256 mismatch (expected $expected, got $actual)"
    }
  } catch [System.Management.Automation.CommandNotFoundException] {
    Write-Host "skvm install.ps1: Get-FileHash not available, skipping checksum" -ForegroundColor Yellow
  } catch {
    Write-Host "skvm install.ps1: no checksum published, skipping verification" -ForegroundColor Yellow
  }

  # ------------ extract ------------
  New-Item -ItemType Directory -Force -Path $SKVM_PREFIX | Out-Null
  New-Item -ItemType Directory -Force -Path $SKVM_BIN_DIR | Out-Null

  Write-Host "skvm install.ps1: extracting..."
  tar -xzf $tmpTarball -C $SKVM_PREFIX

  $binarySrc = Join-Path $SKVM_PREFIX "bin\skvm.exe"
  if (-not (Test-Path $binarySrc)) {
    throw "binary not found after extraction at $binarySrc"
  }

  # Copy binary to BIN_DIR (symlinks are admin-only on Windows)
  $binaryDest = Join-Path $SKVM_BIN_DIR "skvm.exe"
  Copy-Item -Force $binarySrc $binaryDest

  # ------------ PATH hint ------------
  $currentPath = [Environment]::GetEnvironmentVariable("PATH", "User") ?? ""
  if ($currentPath -notlike "*$SKVM_BIN_DIR*") {
    Write-Host ""
    Write-Host "skvm $tag installed to $SKVM_PREFIX"
    Write-Host "Binary: $binaryDest"
    Write-Host ""
    Write-Host "Add to your User PATH (recommended):" -ForegroundColor Cyan
    Write-Host '  [Environment]::SetEnvironmentVariable("PATH", $env:PATH + ";' + $SKVM_BIN_DIR + '", "User")'
    Write-Host ""
    Write-Host "Or add manually via: System Properties → Environment Variables → User PATH"
  } else {
    Write-Host "skvm $tag installed (already on PATH)"
  }

  Write-Host ""
  Write-Host "Next:" -ForegroundColor Green
  Write-Host "  set OPENROUTER_API_KEY=sk-or-..."
  Write-Host "  skvm --help"
} finally {
  Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
}
