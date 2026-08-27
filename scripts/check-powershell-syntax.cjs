'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const scripts = [
  'scripts/cleanup-install-remnants.ps1',
  'scripts/create-previous-install-manifest.ps1',
  'scripts/protect-install-directory.ps1',
  'scripts/restore-previous-install.ps1',
]
const powerShell = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'pwsh'
const parser = [
  '$tokens = $null',
  '$errors = $null',
  '[System.Management.Automation.Language.Parser]::ParseFile($env:DSH_POWERSHELL_FILE, [ref]$tokens, [ref]$errors) > $null',
  'if ($errors.Count -gt 0) {',
  '  $errors | ForEach-Object { Write-Error ("{0}:{1} {2}" -f $_.Extent.StartLineNumber, $_.Extent.StartColumnNumber, $_.Message) }',
  '  exit 1',
  '}',
].join('; ')

for (const relative of scripts) {
  const filename = path.join(projectRoot, relative)
  const result = spawnSync(powerShell, ['-NoProfile', '-NonInteractive', '-Command', parser], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, DSH_POWERSHELL_FILE: filename },
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`PowerShell 5.1 syntax check failed for ${relative}:\n${result.stderr || result.stdout}`)
  }
}

console.log(`PowerShell syntax ok: ${scripts.length} scripts`)
