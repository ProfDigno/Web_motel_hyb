$ErrorActionPreference = 'Stop'
$project = 'C:\Users\Digno\Documents\CODEX\Web_motel_hyb'
$script = Join-Path $project 'scripts\sync-occupancy.ps1'
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Motel Occupancy Sync' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Actualiza el tablero web de ocupacion cada minuto' -Force | Select-Object TaskName,State
