# Troubleshooting

## Common Issues

### "Email credentials missing" or "CSV file not found"

Make sure your `.env` file has:
- `EMAIL_ADDRESS` and `EMAIL_PASSWORD` (for IMAP polling), OR
- `CSV_FILE` pointing to an existing CSV file

Check your `.env` file: `cat .env`

### "OAuth file not found" or "tokens/oauth-token.json missing"

The OAuth credentials files are missing. Contact the **TVCRI Hub** to request:
- `client_secret_*.apps.googleusercontent.com.json`
- `oauth-token.json`

Place both files in the `tokens/` directory.

See [Google OAuth Setup](GOOGLE-OAUTH.md) for details.

### Cron job runs but nothing happens

Check the log file:

```bash
tail -50 sync-cron.log
```

**Common causes:**
- `.env` file is not in the cron working directory
- Email arrives *after* the cron job timeout (increase `POLL_SLOW_DURATION_MS` in `.env`)
- Cron environment doesn't have `PATH` set correctly (use full path to `node` in crontab)

**To test cron setup:**
```bash
# Run cron command manually
0 7-18 * * 1-5 cd /path/to/ce-sheets-sync && node sync.js >> sync-cron.log 2>&1

# Check if it ran
tail sync-cron.log
```

### Windows Task Scheduler task doesn't run

Check the task status:

1. Open **Task Scheduler**
2. Find "CE Sheets Sync" in the task list
3. Right-click → **View** → **History** tab to see if it ran
4. Check the **Last Run Result** (0 = success, non-zero = error)

**Common causes:**
- `.env` file not found (check working directory in task settings)
- `node` is not in PATH or the full path to `node.exe` is wrong
- The batch file `sync.bat` doesn't exist or has the wrong path
- Task ran but output isn't captured (redirect to log file in batch file)

### Sync times out or fails

The robot retries up to 5 times with exponential backoff. If it still fails:

```bash
# Check for errors in the log
grep '"level":"error"' sync-cron.log | tail -10

# Run manually to see detailed output
node sync.js
```

**Common causes:**
- Network connection issues
- Google API quota exceeded
- Club Express report has a different format
- Sheets API is not enabled in Google Cloud

### "Insufficient permissions" or "Permission denied"

The Google account doesn't have access to the sheets.

Check that the account has **Editor** role on all 14 metro area sheets. If you don't have access, contact the TVCRI Hub to request edit permissions or new credentials.

### "Service Unavailable" or Google Sheets API errors

Google API is temporarily unavailable or quota is exceeded.

- Wait a few minutes and try again
- Check [Google Cloud Status Dashboard](https://status.cloud.google.com/)
- Check your API quota: Cloud Console → APIs & Services → Quotas

### Email not being picked up

The robot finds emails but only processes those from `scheduler@mail2.clubexpress.com` with subject `"Report"`.

**Check:**
1. Is the email arriving at `EMAIL_ADDRESS`?
2. Is it from `scheduler@mail2.clubexpress.com`?
3. Is the subject exactly `"Report"` (case-sensitive)?
4. Is the email marked as unread?

**Debug:**
```bash
# Check raw IMAP traffic (verbose logging)
# This isn't implemented yet, but you can add it to sync.js if needed
```

### CSV parsing errors

The robot expects a specific CSV format from Club Express with multi-section headers like:
- `dump-member`
- `dump-service-provider`
- `dump-service-requested`
- etc.

If the format changes, the robot will fail. Check the raw CSV file:

```bash
CSV_FILE=your-file.csv node sync.js 2>&1 | head -100
```

Contact the developer if the Club Express report format has changed.

## Getting Help

If you've checked the above and it's still not working:

1. **Collect logs:**
   ```bash
   tail -100 sync-cron.log > logs-excerpt.txt
   ```

2. **Check .env (without secrets):**
   ```bash
   grep -v PASSWORD .env > env-excerpt.txt
   ```

3. **Run a test manually:**
   ```bash
   CSV_FILE=scratch/dump-chain.csv node sync.js 2>&1 | tee test-run.log
   ```

4. **Contact the developer** with:
   - The log excerpts above
   - Your operating system and Node.js version (`node --version`)
   - What you were trying to do when it failed
   - Any error messages from the logs
