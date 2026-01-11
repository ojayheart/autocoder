# Gmail MCP Setup for Auto-Tester

This guide helps you configure Gmail access for the test account: `claudiosportal@gmail.com`

## Quick Setup (Recommended for VMs)

If you're running in a VM or headless environment, use **Gmail App Password**:

1. Log in to claudiosportal@gmail.com
2. Enable 2-Step Verification: https://myaccount.google.com/security
3. Create App Password: https://myaccount.google.com/apppasswords
   - Select "Mail" and your device
   - Copy the 16-character password
4. Add to your `.env`:
   ```
   GMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
   ```

The tester can then use IMAP/SMTP directly without OAuth.

---

## Full OAuth Setup (For local development)

## Step 1: Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (e.g., "Autocoder Tester")
3. Enable the Gmail API:
   - Go to "APIs & Services" → "Enable APIs"
   - Search for "Gmail API" and enable it

## Step 2: Create OAuth Credentials

1. Go to "APIs & Services" → "Credentials"
2. Click "Create Credentials" → "OAuth client ID"
3. If prompted, configure the OAuth consent screen:
   - User Type: External
   - App name: "Autocoder Tester"
   - User support email: claudiosportal@gmail.com
   - Add your email as a test user
4. Create OAuth client ID:
   - Application type: "Desktop app"
   - Name: "Autocoder Tester"
5. Download the JSON file
6. Save it as: `/Users/oliverhart/autocoder/credentials/google-credentials.json`

## Step 3: Authorize the Test Account

Run the authorization script to generate a token:

```bash
cd /Users/oliverhart/autocoder
node scripts/google-auth.js
```

This will:
1. Open a browser window
2. Log in with `claudiosportal@gmail.com`
3. Grant access to Gmail
4. Save the token to `credentials/google-token.json`

## Step 4: Verify Setup

Test that it works:

```bash
cd /Users/oliverhart/autocoder
node -e "
const { google } = require('googleapis');
const fs = require('fs');
const creds = JSON.parse(fs.readFileSync('credentials/google-credentials.json'));
const token = JSON.parse(fs.readFileSync('credentials/google-token.json'));
const auth = new google.auth.OAuth2(creds.installed.client_id, creds.installed.client_secret);
auth.setCredentials(token);
const gmail = google.gmail({ version: 'v1', auth });
gmail.users.labels.list({ userId: 'me' }).then(res => console.log('Connected! Labels:', res.data.labels.length));
"
```

## Credentials Location

After setup, you should have:
- `credentials/google-credentials.json` - OAuth client configuration
- `credentials/google-token.json` - Access/refresh token for claudiosportal@gmail.com

## Security Notes

- The `credentials/` directory is gitignored
- Never commit tokens or credentials to version control
- The refresh token will automatically renew the access token
