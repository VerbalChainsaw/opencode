# Kill zombies
Get-Process -Name "node","electron" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 1

# Start desktop app
Set-Location "$PSScriptRoot\packages\desktop"
bun run dev
