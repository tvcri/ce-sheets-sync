[← Back to README](../README.md)

# Environment Variables

The `.env` file controls the behavior of the sync robot. Copy `.env.example` and fill in the required settings.

## Email Settings (Required)

| Variable | Description | Example |
|----------|-------------|---------|
| `EMAIL_ADDRESS` | Email address where Club Express sends reports | `tvcri-dump@example.com` |
| `EMAIL_PASSWORD` | Password for the email account (keep secret, do not commit) | `MySecurePassword123` |
| `IMAP_HOST` | IMAP server hostname for your email provider | `imap.gmail.com` or `imap.outlook.com` |
| `IMAP_PORT` | IMAP port (almost always 993 for secure IMAP) | `993` |

## Google Sheets Settings (Required)

| Variable | Description | Example |
|----------|-------------|---------|
| `OAUTH_CLIENT_SECRET_FILE` | Path to Google OAuth client secret JSON (from Google Cloud Console) | `tokens/client_secret_*.apps.googleusercontent.com.json` |
| `OAUTH_TOKEN_FILE` | Path to OAuth refresh token (created automatically on first login) | `tokens/oauth-token.json` |

See [Google OAuth Setup](GOOGLE-OAUTH.md) for instructions on obtaining these credentials.

## Polling Settings (Optional)

The robot polls the email inbox for new reports using a two-phase strategy: check frequently at first, then slow down if no email arrives.

| Variable | Description | Example |
|----------|-------------|---------|
| `POLL_FAST_INTERVAL_MS` | How often to check email during fast phase (milliseconds) | `30000` (30 seconds) |
| `POLL_FAST_DURATION_MS` | How long to stay in fast phase before switching to slow (milliseconds) | `300000` (5 minutes) |
| `POLL_SLOW_INTERVAL_MS` | How often to check email during slow phase (milliseconds) | `60000` (60 seconds) |
| `POLL_SLOW_DURATION_MS` | How long to stay in slow phase before giving up (milliseconds) | `3000000` (50 minutes) |

## Testing Settings (Optional)

| Variable | Description | Example |
|----------|-------------|---------|
| `METRO_AREAS` | Comma-separated metro areas to sync (all 14 if not set) | `"Aquidneck"` or `"Aquidneck,Providence"` |
| `CSV_FILE` | Process a local CSV file instead of polling email | `scratch/dump-chain.csv` |
| `TEST_SPREADSHEET_ID` | Write to a test sheet instead of real sheets (requires `METRO_AREAS`) | `1XM5XHcILLs_0ifn6lbQ4F7JRrFU6lLCjG1u6r163CUs` |

## Village Green Integration (Optional)

After a successful database sync, the robot can notify the Village Green API via a webhook POST. If `VG_SYNC_WEBHOOK_URL` is not set, this step is skipped silently and the sync completes normally. A webhook failure (non-OK HTTP response or network error) is logged as a warning but never aborts the sync.

| Variable | Description | Example |
|----------|-------------|---------|
| `VG_SYNC_WEBHOOK_URL` | URL to POST after a successful database sync | `https://api.villagegreen.example.com/webhooks/ce-sync` |
| `VG_SYNC_WEBHOOK_KEY` | Bearer token sent in the `Authorization` header | `your-webhook-secret-key` |
