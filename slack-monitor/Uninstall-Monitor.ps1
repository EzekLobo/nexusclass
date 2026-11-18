$ErrorActionPreference = 'Stop'
Stop-ScheduledTask -TaskName 'NexusClass Slack Monitor' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'NexusClass Slack Monitor' -Confirm:$false -ErrorAction SilentlyContinue
Write-Host 'Inicialização automática removida. Os dados e a sessão local foram mantidos.'
