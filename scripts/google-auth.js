#!/usr/bin/env node
/**
 * Google OAuth2 Authentication Script
 *
 * Generates a token for accessing Gmail with the test account.
 * Run this once to authorize claudiosportal@gmail.com
 *
 * Usage: node scripts/google-auth.js
 */

const { google } = require('googleapis');
const { readFileSync, writeFileSync, existsSync } = require('fs');
const { createServer } = require('http');
const { parse } = require('url');
const open = require('open').default;
const { join } = require('path');

const CREDENTIALS_PATH = join(__dirname, '../credentials/google-credentials.json');
const TOKEN_PATH = join(__dirname, '../credentials/google-token.json');

// Gmail scopes needed for the tester
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
];

async function authenticate() {
  // Check for credentials file
  if (!existsSync(CREDENTIALS_PATH)) {
    console.error('Error: credentials/google-credentials.json not found!');
    console.error('');
    console.error('Please follow the setup instructions in GMAIL_SETUP.md:');
    console.error('1. Create a Google Cloud project');
    console.error('2. Enable Gmail API');
    console.error('3. Create OAuth credentials');
    console.error('4. Download and save as credentials/google-credentials.json');
    process.exit(1);
  }

  const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    'http://localhost:3333/callback'
  );

  // Generate auth URL
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // Force to get refresh token
  });

  console.log('');
  console.log('='.repeat(60));
  console.log('  Google OAuth2 Authentication');
  console.log('='.repeat(60));
  console.log('');
  console.log('Opening browser for authentication...');
  console.log('');
  console.log('Please log in with: claudiosportal@gmail.com');
  console.log('');

  // Start local server to receive callback
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const { query } = parse(req.url, true);

        if (query.code) {
          // Exchange code for tokens
          const { tokens } = await oauth2Client.getToken(query.code);

          // Save tokens
          writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: system-ui; padding: 40px; text-align: center;">
                <h1>Authentication Successful!</h1>
                <p>You can close this window and return to the terminal.</p>
                <p>Token saved to: credentials/google-token.json</p>
              </body>
            </html>
          `);

          server.close();

          console.log('');
          console.log('Authentication successful!');
          console.log(`Token saved to: ${TOKEN_PATH}`);
          console.log('');

          resolve(tokens);
        } else if (query.error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<html><body><h1>Error: ${query.error}</h1></body></html>`);
          server.close();
          reject(new Error(query.error));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h1>Error: ${err.message}</h1></body></html>`);
        server.close();
        reject(err);
      }
    });

    server.listen(3333, () => {
      // Open browser
      open(authUrl);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Authentication timed out'));
    }, 5 * 60 * 1000);
  });
}

// Run
authenticate()
  .then(() => {
    console.log('Gmail access configured for the auto-tester.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Authentication failed:', err.message);
    process.exit(1);
  });
