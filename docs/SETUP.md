# Setup Guide

## Prerequisites

- **Node.js** v18 or later
- **Google OAuth credentials** (see [Google OAuth Setup](GOOGLE-OAUTH.md))
- **IMAP email account** (credentials in `.env`)

## Installation

```bash
git clone <repo-url> ce-sheets-sync
cd ce-sheets-sync
npm install
```

## Configuration

Copy `.env.example` to `.env` and fill in your settings:

```bash
cp .env.example .env
```

**At minimum, you need:**
- `EMAIL_ADDRESS` and `EMAIL_PASSWORD` — the email account where Club Express sends reports
- `OAUTH_CLIENT_SECRET_FILE` — path to your Google OAuth credentials
- `OAUTH_TOKEN_FILE` — path to the OAuth refresh token (created on first run)

See [Environment Variables](ENV-VARIABLES.md) for details on each setting.

## Run It Manually

**Option 1: Poll for new emails** (recommended for cron)

```bash
node sync.js
```

The robot will poll the email inbox for up to 55 minutes total: checks every 30 seconds for the first 5 minutes (fast phase), then every 60 seconds for the remaining 50 minutes (slow phase). If it finds a new Club Express report at any time, it processes it and exits. If no email arrives, it exits after the 55-minute timeout.

**Option 2: Test with a local CSV file**

```bash
CSV_FILE=path/to/dump-chain.csv node sync.js
```

Useful for testing without relying on email.

**Option 3: Test with a single metro area**

```bash
METRO_AREAS="Aquidneck" node sync.js
```

Only syncs the specified metro area (useful for testing). Can be comma-separated: `"Aquidneck,Providence"`

**Option 4: Test with a test spreadsheet**

```bash
METRO_AREAS="Aquidneck" TEST_SPREADSHEET_ID=<your-test-sheet-id> node sync.js
```

Syncs to your test sheet instead of the real ones. You must specify `METRO_AREAS` with this option.

## Next Steps

- [Schedule it to run automatically](SCHEDULING.md) (cron on Linux/macOS, Task Scheduler on Windows)
- [Configure environment variables](ENV-VARIABLES.md)
- [Set up Google OAuth](GOOGLE-OAUTH.md)
