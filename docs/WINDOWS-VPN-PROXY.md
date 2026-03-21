# Windows VPN Proxy Setup

NanoClaw runs in Docker containers on WSL2. When tools need to reach internal services
(e.g. TeamCity) that are only accessible via corporate VPN, extra setup is needed because
Docker containers cannot reach the Windows VPN tunnel directly.

## WSL2 Mirrored Networking

Enable mirrored networking so WSL2 shares the Windows network stack (including VPN routes).

Create or edit `C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
```

Then restart WSL2 from PowerShell:

```powershell
wsl --shutdown
```

## Windows Port Proxy

Even with mirrored networking, Docker containers cannot reach VPN hosts directly.
Set up a Windows port proxy that forwards a local port to the internal service.

Run in PowerShell **as Administrator**:

```powershell
# Forward localhost:8110 -> TeamCity (adjust IP/port as needed)
netsh interface portproxy add v4tov4 listenport=8110 listenaddress=0.0.0.0 connectport=80 connectaddress=10.162.20.61

# Allow the port through Windows Firewall
netsh advfirewall firewall add rule name="TeamCity Proxy" dir=in action=allow protocol=TCP localport=8110
```

To verify:
```powershell
netsh interface portproxy show all
Test-NetConnection localhost -Port 8110
```

**Make it persistent** — create a scheduled task to run at login (paste as a single line in PowerShell as Administrator):

```powershell
$action = New-ScheduledTaskAction -Execute "netsh" -Argument "interface portproxy add v4tov4 listenport=8110 listenaddress=0.0.0.0 connectport=80 connectaddress=10.162.20.61"; $trigger = New-ScheduledTaskTrigger -AtLogOn; $settings = New-ScheduledTaskSettingsSet -RunOnlyIfNetworkAvailable; Register-ScheduledTask -TaskName "TeamCity VPN Proxy" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force
```

## MCP Configuration

In `data/sessions/<group>/.claude/.mcp.json`, use `host.docker.internal` to reach the proxy from inside the container:

```json
{
  "mcpServers": {
    "teamcity": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@daghis/teamcity-mcp"],
      "env": {
        "TEAMCITY_URL": "http://host.docker.internal:8110",
        "TEAMCITY_TOKEN": "${TEAMCITY_TOKEN}"
      }
    }
  }
}
```

The `TEAMCITY_TOKEN` variable is injected from `.env` at container startup.
