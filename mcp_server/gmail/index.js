#!/usr/bin/env node
/**
 * Gmail MCP Server for Autocoder Testing
 *
 * Provides tools to read, search, and send emails via Gmail.
 * Used by the auto-tester agent to read verification emails, 2FA codes, etc.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths to credentials - resolve relative to the script location
// Default paths point to autocoder/credentials/
function getCredentialsPath() {
  return process.env.GOOGLE_CREDENTIALS_PATH || join(__dirname, '../../credentials/google-credentials.json');
}

function getTokenPath() {
  return process.env.GOOGLE_TOKEN_PATH || join(__dirname, '../../credentials/google-token.json');
}

// Initialize Gmail API with automatic token refresh
function getGmailClient() {
  const credentialsPath = getCredentialsPath();
  const tokenPath = getTokenPath();
  
  if (!existsSync(credentialsPath)) {
    throw new Error(`Credentials file not found: ${credentialsPath}`);
  }
  
  if (!existsSync(tokenPath)) {
    throw new Error(`Token file not found: ${tokenPath}. Please run scripts/google-auth.js to authenticate.`);
  }
  
  const credentials = JSON.parse(readFileSync(credentialsPath, 'utf-8'));
  let token = JSON.parse(readFileSync(tokenPath, 'utf-8'));
  
  const { client_id, client_secret } = credentials.installed || credentials.web;
  
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret);
  oauth2Client.setCredentials(token);
  
  // Handle automatic token refresh
  oauth2Client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      token.refresh_token = tokens.refresh_token;
    }
    if (tokens.access_token) {
      token.access_token = tokens.access_token;
    }
    if (tokens.expiry_date) {
      token.expiry_date = tokens.expiry_date;
    }
    // Save updated token
    try {
      writeFileSync(tokenPath, JSON.stringify(token, null, 2));
    } catch (writeError) {
      // If we can't write the token, log but don't fail
      console.error('Failed to save refreshed token:', writeError.message);
    }
  });
  
  // Try to refresh token if it's expired or about to expire
  if (token.expiry_date && token.expiry_date <= Date.now() + 60000) {
    // Token expired or expires in less than 1 minute, try to refresh
    oauth2Client.refreshAccessToken().catch(() => {
      // If refresh fails, the API call will handle the error
    });
  }
  
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// Tool handlers
async function listEmails(args) {
  const { maxResults = 10, query = '', labelIds = ['INBOX'] } = args;
  const gmail = getGmailClient();
  
  const response = await gmail.users.messages.list({
    userId: 'me',
    maxResults,
    q: query,
    labelIds,
  });
  
  const messages = response.data.messages || [];
  const emails = [];
  
  for (const msg of messages) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'],
    });
    
    const headers = detail.data.payload.headers;
    const getHeader = (name) => headers.find(h => h.name === name)?.value || '';
    
    emails.push({
      id: msg.id,
      threadId: msg.threadId,
      from: getHeader('From'),
      subject: getHeader('Subject'),
      date: getHeader('Date'),
      snippet: detail.data.snippet,
    });
  }
  
  return { emails, totalResults: response.data.resultSizeEstimate };
}

async function getEmail(args) {
  const { messageId } = args;
  const gmail = getGmailClient();
  
  const response = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });
  
  const headers = response.data.payload.headers;
  const getHeader = (name) => headers.find(h => h.name === name)?.value || '';
  
  // Extract body
  let body = '';
  const payload = response.data.payload;
  
  if (payload.body?.data) {
    body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
  } else if (payload.parts) {
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
    }
  }
  
  return {
    id: response.data.id,
    threadId: response.data.threadId,
    from: getHeader('From'),
    to: getHeader('To'),
    subject: getHeader('Subject'),
    date: getHeader('Date'),
    body: body.slice(0, 5000), // Limit body size
    labels: response.data.labelIds,
  };
}

async function searchEmails(args) {
  const { query, maxResults = 20 } = args;
  return listEmails({ query, maxResults, labelIds: [] });
}

async function getUnreadCount() {
  const gmail = getGmailClient();
  
  const response = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread',
    maxResults: 1,
  });
  
  return { 
    unreadCount: response.data.resultSizeEstimate || 0 
  };
}

async function listLabels() {
  const gmail = getGmailClient();
  
  const response = await gmail.users.labels.list({
    userId: 'me',
  });
  
  return {
    labels: response.data.labels.map(l => ({
      id: l.id,
      name: l.name,
      type: l.type,
    })),
  };
}

async function trashEmails(args) {
  const { messageIds } = args;
  const gmail = getGmailClient();
  
  const results = [];
  for (const id of messageIds) {
    try {
      await gmail.users.messages.trash({
        userId: 'me',
        id: id,
      });
      results.push({ id, status: 'trashed' });
    } catch (error) {
      results.push({ id, status: 'error', error: error.message });
    }
  }
  
  return { trashed: results.filter(r => r.status === 'trashed').length, results };
}

async function markAsRead(args) {
  const { messageIds } = args;
  const gmail = getGmailClient();
  
  const results = [];
  for (const id of messageIds) {
    try {
      await gmail.users.messages.modify({
        userId: 'me',
        id: id,
        requestBody: {
          removeLabelIds: ['UNREAD'],
        },
      });
      results.push({ id, status: 'marked_read' });
    } catch (error) {
      results.push({ id, status: 'error', error: error.message });
    }
  }
  
  return { marked: results.filter(r => r.status === 'marked_read').length, results };
}

async function createLabel(args) {
  const { name, backgroundColor, textColor } = args;
  const gmail = getGmailClient();
  
  const labelBody = {
    name,
    labelListVisibility: 'labelShow',
    messageListVisibility: 'show',
  };
  
  // Add colors if provided
  if (backgroundColor || textColor) {
    labelBody.color = {};
    if (backgroundColor) labelBody.color.backgroundColor = backgroundColor;
    if (textColor) labelBody.color.textColor = textColor;
  }
  
  const response = await gmail.users.labels.create({
    userId: 'me',
    requestBody: labelBody,
  });
  
  return {
    id: response.data.id,
    name: response.data.name,
    type: response.data.type,
  };
}

async function deleteLabel(args) {
  const { labelId } = args;
  const gmail = getGmailClient();
  
  await gmail.users.labels.delete({
    userId: 'me',
    id: labelId,
  });
  
  return { deleted: true, labelId };
}

async function modifyEmailLabels(args) {
  const { messageIds, addLabelIds = [], removeLabelIds = [] } = args;
  const gmail = getGmailClient();
  
  const results = [];
  for (const id of messageIds) {
    try {
      await gmail.users.messages.modify({
        userId: 'me',
        id: id,
        requestBody: {
          addLabelIds,
          removeLabelIds,
        },
      });
      results.push({ id, status: 'modified' });
    } catch (error) {
      results.push({ id, status: 'error', error: error.message });
    }
  }
  
  return { 
    modified: results.filter(r => r.status === 'modified').length, 
    results 
  };
}

async function batchModifyLabels(args) {
  const { messageIds, addLabelIds = [], removeLabelIds = [] } = args;
  const gmail = getGmailClient();
  
  // Use batch modify for efficiency with large numbers of emails
  await gmail.users.messages.batchModify({
    userId: 'me',
    requestBody: {
      ids: messageIds,
      addLabelIds,
      removeLabelIds,
    },
  });
  
  return { 
    success: true,
    count: messageIds.length,
    addedLabels: addLabelIds,
    removedLabels: removeLabelIds,
  };
}

async function sendEmail(args) {
  const { to, subject, body, cc, bcc, replyTo, threadId, htmlBody, attachments } = args;
  const gmail = getGmailClient();
  
  if (!to || !subject || (!body && !htmlBody)) {
    throw new Error('to, subject, and body (or htmlBody) are required');
  }
  
  // Build email headers
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
  ];
  
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);
  if (threadId) headers.push(`In-Reply-To: ${threadId}`);
  
  // Build email message
  let email = headers.join('\r\n') + '\r\n';
  
  const hasAttachments = attachments && attachments.length > 0;
  
  if (hasAttachments) {
    // Multipart/mixed for messages with attachments
    const mixedBoundary = `----=_Mixed_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    email += `MIME-Version: 1.0\r\n`;
    email += `Content-Type: multipart/mixed; boundary="${mixedBoundary}"\r\n\r\n`;
    
    // Add body content (multipart/alternative if HTML, or plain text)
    if (htmlBody) {
      const altBoundary = `----=_Alternative_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      email += `--${mixedBoundary}\r\n`;
      email += `Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`;
      
      // Plain text version
      email += `--${altBoundary}\r\n`;
      email += `Content-Type: text/plain; charset=UTF-8\r\n`;
      email += `Content-Transfer-Encoding: 7bit\r\n\r\n`;
      email += body || htmlBody.replace(/<[^>]*>/g, '') + '\r\n\r\n';
      
      // HTML version
      email += `--${altBoundary}\r\n`;
      email += `Content-Type: text/html; charset=UTF-8\r\n`;
      email += `Content-Transfer-Encoding: 7bit\r\n\r\n`;
      email += htmlBody + '\r\n\r\n';
      
      email += `--${altBoundary}--\r\n\r\n`;
    } else {
      email += `--${mixedBoundary}\r\n`;
      email += `Content-Type: text/plain; charset=UTF-8\r\n`;
      email += `Content-Transfer-Encoding: 7bit\r\n\r\n`;
      email += body + '\r\n\r\n';
    }
    
    // Add attachments
    for (const attachment of attachments) {
      const { path, filename, contentType } = attachment;
      
      if (!existsSync(path)) {
        throw new Error(`Attachment file not found: ${path}`);
      }
      
      const fileContent = readFileSync(path);
      const base64Content = fileContent.toString('base64');
      const mimeType = contentType || 'application/octet-stream';
      const attachmentFilename = filename || path.split('/').pop();
      
      email += `--${mixedBoundary}\r\n`;
      email += `Content-Type: ${mimeType}\r\n`;
      email += `Content-Disposition: attachment; filename="${attachmentFilename}"\r\n`;
      email += `Content-Transfer-Encoding: base64\r\n\r\n`;
      email += base64Content + '\r\n\r\n';
    }
    
    email += `--${mixedBoundary}--\r\n`;
  } else if (htmlBody) {
    // Multipart message with both HTML and plain text (no attachments)
    const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    email += `MIME-Version: 1.0\r\n`;
    email += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`;
    
    // Plain text version (fallback)
    email += `--${boundary}\r\n`;
    email += `Content-Type: text/plain; charset=UTF-8\r\n`;
    email += `Content-Transfer-Encoding: 7bit\r\n\r\n`;
    email += body || htmlBody.replace(/<[^>]*>/g, '') + '\r\n\r\n';
    
    // HTML version
    email += `--${boundary}\r\n`;
    email += `Content-Type: text/html; charset=UTF-8\r\n`;
    email += `Content-Transfer-Encoding: 7bit\r\n\r\n`;
    email += htmlBody + '\r\n\r\n';
    
    email += `--${boundary}--\r\n`;
  } else {
    // Plain text only
    email += `Content-Type: text/plain; charset=UTF-8\r\n`;
    email += `Content-Transfer-Encoding: 7bit\r\n\r\n`;
    email += body;
  }
  
  // Encode message in base64url format (required by Gmail API)
  const encodedMessage = Buffer.from(email)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  
  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedMessage,
      threadId: threadId || undefined,
    },
  });
  
  return {
    success: true,
    messageId: response.data.id,
    threadId: response.data.threadId,
    to,
    subject,
    attachmentsCount: hasAttachments ? attachments.length : 0,
  };
}

// Server setup
const server = new Server(
  { name: 'autocoder-gmail', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_emails',
      description: 'List recent emails from inbox or other labels',
      inputSchema: {
        type: 'object',
        properties: {
          maxResults: { type: 'number', description: 'Max emails to return (default: 10)' },
          query: { type: 'string', description: 'Gmail search query (e.g., "from:someone@example.com")' },
          labelIds: { type: 'array', items: { type: 'string' }, description: 'Label IDs to filter by' },
        },
      },
    },
    {
      name: 'get_email',
      description: 'Get full details of a specific email by ID',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'The email message ID' },
        },
        required: ['messageId'],
      },
    },
    {
      name: 'search_emails',
      description: 'Search emails with Gmail query syntax',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Gmail search query (e.g., "subject:invoice after:2024/01/01")' },
          maxResults: { type: 'number', description: 'Max results (default: 20)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_unread_count',
      description: 'Get count of unread emails',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'list_labels',
      description: 'List all Gmail labels',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'trash_emails',
      description: 'Move emails to trash',
      inputSchema: {
        type: 'object',
        properties: {
          messageIds: { 
            type: 'array', 
            items: { type: 'string' },
            description: 'Array of email message IDs to trash' 
          },
        },
        required: ['messageIds'],
      },
    },
    {
      name: 'mark_as_read',
      description: 'Mark emails as read',
      inputSchema: {
        type: 'object',
        properties: {
          messageIds: { 
            type: 'array', 
            items: { type: 'string' },
            description: 'Array of email message IDs to mark as read' 
          },
        },
        required: ['messageIds'],
      },
    },
    {
      name: 'create_label',
      description: 'Create a new Gmail label/folder',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Label name (use "/" for nested labels, e.g., "Clients/Aro Ha")' },
          backgroundColor: { type: 'string', description: 'Optional hex color for background (e.g., "#16a765")' },
          textColor: { type: 'string', description: 'Optional hex color for text (e.g., "#ffffff")' },
        },
        required: ['name'],
      },
    },
    {
      name: 'delete_label',
      description: 'Delete a Gmail label',
      inputSchema: {
        type: 'object',
        properties: {
          labelId: { type: 'string', description: 'The label ID to delete' },
        },
        required: ['labelId'],
      },
    },
    {
      name: 'modify_email_labels',
      description: 'Add or remove labels from emails (move to folders)',
      inputSchema: {
        type: 'object',
        properties: {
          messageIds: { 
            type: 'array', 
            items: { type: 'string' },
            description: 'Array of email message IDs to modify' 
          },
          addLabelIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Label IDs to add to the emails',
          },
          removeLabelIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Label IDs to remove from the emails (use "INBOX" to archive)',
          },
        },
        required: ['messageIds'],
      },
    },
    {
      name: 'batch_modify_labels',
      description: 'Efficiently modify labels on many emails at once (up to 1000)',
      inputSchema: {
        type: 'object',
        properties: {
          messageIds: { 
            type: 'array', 
            items: { type: 'string' },
            description: 'Array of email message IDs to modify (max 1000)' 
          },
          addLabelIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Label IDs to add to all emails',
          },
          removeLabelIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Label IDs to remove from all emails',
          },
        },
        required: ['messageIds'],
      },
    },
    {
      name: 'send_email',
      description: 'Send an email via Gmail',
      inputSchema: {
        type: 'object',
        properties: {
          to: { 
            type: 'string', 
            description: 'Recipient email address(es). For multiple recipients, use comma-separated values.' 
          },
          subject: { 
            type: 'string', 
            description: 'Email subject line' 
          },
          body: { 
            type: 'string', 
            description: 'Plain text email body. Use either body or htmlBody (or both for multipart).' 
          },
          htmlBody: { 
            type: 'string', 
            description: 'HTML email body. If provided with body, creates a multipart message.' 
          },
          cc: { 
            type: 'string', 
            description: 'CC recipient email address(es). Comma-separated for multiple.' 
          },
          bcc: { 
            type: 'string', 
            description: 'BCC recipient email address(es). Comma-separated for multiple.' 
          },
          replyTo: { 
            type: 'string', 
            description: 'Reply-To email address' 
          },
          threadId: { 
            type: 'string', 
            description: 'Thread ID to reply to an existing conversation' 
          },
          attachments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'File path to the attachment' },
                filename: { type: 'string', description: 'Optional filename for the attachment (defaults to basename of path)' },
                contentType: { type: 'string', description: 'Optional MIME type (e.g., "application/pdf", defaults to "application/octet-stream")' },
              },
              required: ['path'],
            },
            description: 'Array of file attachments to include in the email',
          },
        },
        required: ['to', 'subject'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  
  let result;
  
  try {
    switch (name) {
      case 'list_emails':
        result = await listEmails(args);
        break;
      case 'get_email':
        result = await getEmail(args);
        break;
      case 'search_emails':
        result = await searchEmails(args);
        break;
      case 'get_unread_count':
        result = await getUnreadCount();
        break;
      case 'list_labels':
        result = await listLabels();
        break;
      case 'trash_emails':
        result = await trashEmails(args);
        break;
      case 'mark_as_read':
        result = await markAsRead(args);
        break;
      case 'create_label':
        result = await createLabel(args);
        break;
      case 'delete_label':
        result = await deleteLabel(args);
        break;
      case 'modify_email_labels':
        result = await modifyEmailLabels(args);
        break;
      case 'batch_modify_labels':
        result = await batchModifyLabels(args);
        break;
      case 'send_email':
        result = await sendEmail(args);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    let errorMessage = error.message;
    
    // Handle authentication errors
    if (error.code === 401 || error.message.includes('invalid_grant') || error.message.includes('invalid_token')) {
      errorMessage = `Gmail authentication expired. Please run 'node scripts/google-auth.js' to re-authenticate. Original error: ${error.message}`;
    } else if (error.message.includes('Credentials file not found') || error.message.includes('Token file not found')) {
      errorMessage = error.message;
    }
    
    return {
      content: [{ type: 'text', text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Autocoder Gmail MCP server started');
}

main().catch(console.error);

