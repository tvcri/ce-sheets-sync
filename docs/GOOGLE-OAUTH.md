[← Back to README](../README.md)

# Google OAuth Setup

The robot needs OAuth credentials to access Google Sheets.

## Getting OAuth Credentials

Contact the **TVCRI Hub** to request the OAuth credentials files:
- `client_secret_*.apps.googleusercontent.com.json`
- `oauth-token.json`

Place these files in the `tokens/` directory of your local repository.

## Configuration

The robot will automatically use the credentials files to authenticate with Google Sheets on each run.
