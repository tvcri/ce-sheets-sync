# Running as a Scheduled Job

## Linux / macOS (Cron)

To run the sync automatically, schedule it with cron. Edit your crontab:

```bash
crontab -e
```

**Run every hour, 7am–6pm, Monday–Friday:**

```
0 7-18 * * 1-5 cd /path/to/ce-sheets-sync && node sync.js >> sync-cron.log 2>&1
```

**Important:** Make sure:
- The `.env` file is in the same directory as `sync.js`
- Your cron user has permission to read `.env` and write to `sync-cron.log`
- The path to `node` is correct (use `which node` to find it if needed)

### Monitoring Logs

Logs are written as structured JSON to stdout. Check the cron log file:

```bash
# View recent errors
grep '"level":"error"' sync-cron.log | tail -20

# View successful syncs
grep '"level":"info"' sync-cron.log | grep "complete"

# View the last 100 lines
tail -100 sync-cron.log
```

## Windows (Task Scheduler)

**Option A: Command Line (schtasks)**

Open PowerShell or Command Prompt and run:

```powershell
$taskName = "CE Sheets Sync"
$nodePath = (Get-Command node).Source
$repoPath = "C:\path\to\ce-sheets-sync"
$scriptPath = "$repoPath\sync.js"
$logPath = "$repoPath\sync-cron.log"

# Create a batch file wrapper
@"
@echo off
cd /d "$repoPath"
node sync.js >> "$logPath" 2>&1
"@ | Out-File -FilePath "$repoPath\sync.bat" -Encoding ASCII

# Create the scheduled task (every hour, 7am-6pm, Monday-Friday)
$taskAction = New-ScheduledTaskAction -Execute "$repoPath\sync.bat"
$taskTriggers = @()
for ($hour = 7; $hour -le 18; $hour++) {
    $taskTriggers += New-ScheduledTaskTrigger -Daily -At "$($hour):00" -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday
}
$taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RunOnlyIfNetworkAvailable
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTriggers -Settings $taskSettings -Description "Sync Club Express data to Google Sheets" -Force
```

Or use the simpler `schtasks` command (runs every hour 7am-6pm, Mon-Fri):

```cmd
schtasks /create /tn "CE Sheets Sync" /tr "C:\path\to\ce-sheets-sync\sync.bat" /sc hourly /st 07:00 /du 12:00 /sd 01/01/2026 /d MON,TUE,WED,THU,FRI /f
```

**Option B: GUI (Task Scheduler)**

1. Open **Task Scheduler** (search "Task Scheduler" in Start menu)
2. Click **Create Basic Task**
3. Name: `CE Sheets Sync` (or similar)
4. **Trigger:** Click **New** → Set to repeat **Daily**, **7:00 AM**, **Repeat every 1 hour for a duration of 12 hours**
   - Alternatively, create multiple daily triggers (one per hour from 7am–6pm) for more control
5. **Action:** Click **New**
   - Program: `C:\path\to\ce-sheets-sync\sync.bat` (the batch file below)
   - Start in: `C:\path\to\ce-sheets-sync` (the repo directory)
6. **Conditions:** Uncheck "Stop if the computer switches to battery power" (or adjust as needed)
7. **Settings:** Check "Allow task to be scheduled on demand" and "Run task as soon as possible after a scheduled start is missed"
8. Click **OK** and enter your Windows password when prompted

**Log output:** Create a batch file wrapper (`sync.bat`) in the repo directory:

```batch
@echo off
cd /d "C:\path\to\ce-sheets-sync"
node sync.js >> sync-cron.log 2>&1
```

Then reference this batch file in the Task Scheduler action (both GUI and schtasks methods above).

### Monitoring Logs

On Windows, check the log file:

```cmd
# View the last 50 lines
type sync-cron.log | findstr /E "^" | more
```

Or open `sync-cron.log` directly in Notepad.
