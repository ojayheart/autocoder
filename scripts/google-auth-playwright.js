#!/usr/bin/env node
/**
 * Google OAuth2 Authentication via Playwright
 *
 * Automatically logs into Google and authorizes Gmail access.
 * Uses Playwright to handle the OAuth flow headlessly.
 *
 * Usage: node scripts/google-auth-playwright.js
 */

const { chromium } = require('playwright');
const { google } = require('googleapis');
const { readFileSync, writeFileSync, existsSync } = require('fs');
const { createServer } = require('http');
const { parse } = require('url');
const { join } = require('path');

const CREDENTIALS_PATH = join(__dirname, '../credentials/google-credentials.json');
const TOKEN_PATH = join(__dirname, '../credentials/google-token.json');

// Test account credentials from .env
const TESTER_EMAIL = process.env.TESTER_EMAIL || 'claudiosportal@gmail.com';
const TESTER_PASSWORD = process.env.TESTER_PASSWORD || 'ClaudiosPortal123!';

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
    console.error('Please follow the setup instructions in GMAIL_SETUP.md');
    process.exit(1);
  }

  const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const { client_id, client_secret } = credentials.installed || credentials.web;

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    'http://localhost:3333/callback'
  );

  // Generate auth URL
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('');
  console.log('='.repeat(60));
  console.log('  Google OAuth2 Authentication (Playwright)');
  console.log('='.repeat(60));
  console.log('');
  console.log(`Authenticating as: ${TESTER_EMAIL}`);
  console.log('');

  // Start local server to receive callback
  let authCode = null;
  const serverPromise = new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const { query } = parse(req.url, true);

      if (query.code) {
        authCode = query.code;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body style="font-family: system-ui; padding: 40px; text-align: center;">
              <h1>Authentication Successful!</h1>
              <p>You can close this window.</p>
            </body>
          </html>
        `);
        server.close();
        resolve(authCode);
      } else if (query.error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h1>Error: ${query.error}</h1></body></html>`);
        server.close();
        reject(new Error(query.error));
      }
    });

    server.listen(3333, () => {
      console.log('Callback server listening on http://localhost:3333');
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Authentication timed out'));
    }, 2 * 60 * 1000);
  });

  // Launch browser and perform OAuth flow
  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: false,  // Show browser for debugging, set to true for headless
    slowMo: 100,      // Slow down actions for visibility
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Navigate to OAuth consent page
    console.log('Navigating to Google login...');
    await page.goto(authUrl);

    // Wait for email input and enter email
    console.log('Entering email...');
    await page.waitForSelector('input[type="email"]', { timeout: 30000 });
    await page.fill('input[type="email"]', TESTER_EMAIL);
    await page.click('#identifierNext, button[type="submit"]');

    // Wait for password input and enter password
    console.log('Entering password...');
    await page.waitForSelector('input[type="password"]:visible', { timeout: 30000 });
    await page.fill('input[type="password"]', TESTER_PASSWORD);
    await page.click('#passwordNext, button[type="submit"]');

    // Handle potential "Choose an account" screen
    try {
      const accountSelector = await page.waitForSelector(`text="${TESTER_EMAIL}"`, { timeout: 5000 });
      if (accountSelector) {
        await accountSelector.click();
      }
    } catch (e) {
      // No account selection needed, continue
    }

    // Wait for consent screen and click through
    console.log('Waiting for consent screen...');

    // Sometimes there's a "Continue" button first
    try {
      const continueBtn = await page.waitForSelector('button:has-text("Continue"), button:has-text("Next")', { timeout: 5000 });
      if (continueBtn) {
        await continueBtn.click();
      }
    } catch (e) {
      // No continue button, proceed
    }

    // Handle consent screen - must check all permission checkboxes
    try {
      // Wait for the consent page to fully load
      console.log('Waiting for consent page to load...');
      await page.waitForTimeout(3000);

      // Take a screenshot to see current state
      await page.screenshot({ path: 'consent-page.png' });
      console.log('Screenshot saved to consent-page.png');

      // Function to check all checkboxes
      async function checkAllBoxes() {
        // Try multiple methods to find and check checkboxes

        // Method 1: Standard checkboxes
        const checkboxes = await page.$$('input[type="checkbox"]');
        console.log(`Found ${checkboxes.length} standard checkboxes`);
        for (const cb of checkboxes) {
          const isChecked = await cb.isChecked();
          if (!isChecked) {
            await cb.check();
            console.log('Checked a standard checkbox');
            await page.waitForTimeout(200);
          }
        }

        // Method 2: Role-based checkboxes (Google often uses these)
        const roleCheckboxes = await page.$$('[role="checkbox"]');
        console.log(`Found ${roleCheckboxes.length} role-based checkboxes`);
        for (const cb of roleCheckboxes) {
          const ariaChecked = await cb.getAttribute('aria-checked');
          if (ariaChecked === 'false') {
            await cb.click();
            console.log('Clicked role-based checkbox');
            await page.waitForTimeout(200);
          }
        }

        // Method 3: Clickable list items that act as checkboxes (Google's style)
        const listItems = await page.$$('li[role="listitem"], div[role="option"]');
        for (const item of listItems) {
          try {
            await item.click();
            console.log('Clicked list item checkbox');
            await page.waitForTimeout(200);
          } catch (e) {
            // Item might not be a checkbox
          }
        }

        // Method 4: "Select all" link if exists
        try {
          const selectAll = await page.$('a:has-text("Select all"), button:has-text("Select all")');
          if (selectAll) {
            await selectAll.click();
            console.log('Clicked Select All');
            await page.waitForTimeout(500);
          }
        } catch (e) {}
      }

      // Check all boxes
      await checkAllBoxes();

      // Now click Continue
      console.log('Looking for Continue button...');
      try {
        const continueBtn = await page.waitForSelector('button:has-text("Continue")', { timeout: 5000 });
        if (continueBtn) {
          await page.screenshot({ path: 'before-continue.png' });
          console.log('Clicking Continue...');
          await continueBtn.click();
          await page.waitForTimeout(2000);
        }
      } catch (e) {
        console.log('No Continue button found');
      }

      // Check if we hit the "no access" dialog
      const pageContent = await page.content();
      if (pageContent.includes('without allowing') || pageContent.includes('Do you want to continue')) {
        console.log('Hit the no-access dialog, going back to check boxes...');
        await page.screenshot({ path: 'no-access-dialog.png' });

        // Click the "Back" button to go back and properly check boxes
        try {
          const backBtn = await page.waitForSelector('button:has-text("Back")', { timeout: 3000 });
          if (backBtn) {
            await backBtn.click();
            await page.waitForTimeout(1000);

            // Check all boxes again, more aggressively
            await checkAllBoxes();

            // Click Continue again
            const continueBtn2 = await page.waitForSelector('button:has-text("Continue")', { timeout: 3000 });
            if (continueBtn2) {
              await continueBtn2.click();
              await page.waitForTimeout(2000);
            }
          }
        } catch (e) {
          console.log('Could not handle no-access dialog:', e.message);
        }
      }

      // Final consent button
      try {
        const allowBtn = await page.waitForSelector('#submit_approve_access, button:has-text("Allow")', { timeout: 5000 });
        if (allowBtn) {
          console.log('Clicking final Allow button...');
          await allowBtn.click();
        }
      } catch (e) {
        console.log('No final Allow button needed');
      }

    } catch (e) {
      console.log('Consent handling error:', e.message);
      await page.screenshot({ path: 'consent-error.png' });
    }

    // Wait for redirect to callback URL
    console.log('Waiting for OAuth callback...');
    const code = await serverPromise;

    console.log('Got authorization code, exchanging for tokens...');

    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);

    // Save tokens
    writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

    console.log('');
    console.log('Authentication successful!');
    console.log(`Token saved to: ${TOKEN_PATH}`);
    console.log('');

    return tokens;

  } catch (error) {
    console.error('Authentication error:', error.message);

    // Take a screenshot for debugging
    await page.screenshot({ path: 'auth-error.png' });
    console.error('Screenshot saved to auth-error.png');

    throw error;
  } finally {
    await browser.close();
  }
}

// Load .env if available
try {
  require('dotenv').config({ path: join(__dirname, '../.env') });
} catch (e) {
  // dotenv not available, use defaults
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
