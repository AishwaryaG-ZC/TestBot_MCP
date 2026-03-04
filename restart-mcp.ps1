# Force restart MCP server for Windsurf
Write-Host "Killing all Node processes..." -ForegroundColor Yellow
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Host "Clearing MCP cache..." -ForegroundColor Yellow
Remove-Item -Recurse -Force "$env:APPDATA\Windsurf\mcp-cache" -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Done! Now:" -ForegroundColor Green
Write-Host "1. Close Windsurf completely (Quit from taskbar)" -ForegroundColor Cyan
Write-Host "2. Reopen Windsurf" -ForegroundColor Cyan
Write-Host "3. Check testbot-mcp\logs\mcp.log for this line:" -ForegroundColor Cyan
Write-Host "   [DEBUG] TestBot MCP Server starting - VERSION WITH ZOD SCHEMAS" -ForegroundColor White
Write-Host ""
Write-Host "If you don't see the debug message, the MCP server is loading from a different location." -ForegroundColor Yellow
