$ErrorActionPreference = 'Stop'
$monitorDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node -ErrorAction Stop).Source
Push-Location $monitorDirectory
try {
  npm install
  npx playwright install chromium
} finally { Pop-Location }
$action = New-ScheduledTaskAction -Execute $node -Argument 'src/worker.mjs' -WorkingDirectory $monitorDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName 'NexusClass Slack Monitor' -Action $action -Trigger $trigger -Settings $settings -Description 'Consulta menções não lidas do Slack para sugestões no NexusClass.' -Force | Out-Null
Start-ScheduledTask -TaskName 'NexusClass Slack Monitor'
Write-Host 'Monitor do NexusClass instalado e iniciado. Faça o vínculo em Configurações > Integrações.'
