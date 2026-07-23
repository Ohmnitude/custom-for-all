import { createReadStream, mkdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import nodemailer from 'nodemailer';

const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '8787', 10);
const DATA_DIR = process.env.DATA_DIR || join(PROJECT_ROOT, 'data');
const TEST_SITE_KEY = '1x00000000000000000000AA';
const TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || (IS_PRODUCTION ? '' : TEST_SITE_KEY);
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || (IS_PRODUCTION ? '' : TEST_SECRET_KEY);
const TURNSTILE_ALLOWED_HOSTNAMES = new Set(
  (process.env.TURNSTILE_ALLOWED_HOSTNAMES || '')
    .split(',')
    .map((hostname) => hostname.trim().toLowerCase())
    .filter(Boolean),
);
const INQUIRY_RECIPIENT = process.env.INQUIRY_RECIPIENT || 'customforall@gmail.com';
const MAX_BODY_BYTES = 32 * 1024;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

if (IS_PRODUCTION) {
  const required = [
    'TURNSTILE_SITE_KEY',
    'TURNSTILE_SECRET_KEY',
    'TURNSTILE_ALLOWED_HOSTNAMES',
    'SMTP_HOST',
    'SMTP_USER',
    'SMTP_PASS',
    'SMTP_FROM',
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing required production settings: ${missing.join(', ')}`);
}

mkdirSync(DATA_DIR, { recursive: true });
const databasePath = join(DATA_DIR, 'inquiries.sqlite');
const db = new DatabaseSync(databasePath);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS inquiries (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    business TEXT NOT NULL,
    industry TEXT NOT NULL,
    current_website TEXT NOT NULL,
    features TEXT NOT NULL,
    budget TEXT NOT NULL,
    timeline TEXT NOT NULL,
    details TEXT NOT NULL,
    referral TEXT NOT NULL,
    turnstile_hostname TEXT NOT NULL,
    email_status TEXT NOT NULL,
    smtp_message_id TEXT NOT NULL,
    delivery_error TEXT NOT NULL
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS inquiries_created_at_idx ON inquiries (created_at DESC)');

const insertInquiry = db.prepare(`
  INSERT INTO inquiries (
    id, created_at, name, email, phone, business, industry, current_website,
    features, budget, timeline, details, referral, turnstile_hostname,
    email_status, smtp_message_id, delivery_error
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateDelivery = db.prepare(`
  UPDATE inquiries
  SET email_status = ?, smtp_message_id = ?, delivery_error = ?
  WHERE id = ?
`);

const smtpConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const mailer = smtpConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number.parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    })
  : nodemailer.createTransport({ jsonTransport: true });

const rateLimitBuckets = new Map();
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function sendJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function getClientIp(request) {
  return String(
    request.headers['cf-connecting-ip']
      || request.headers['x-real-ip']
      || request.socket.remoteAddress
      || 'unknown',
  ).split(',')[0].trim();
}

function isRateLimited(ip) {
  const now = Date.now();
  if (rateLimitBuckets.size >= 10_000) {
    for (const [bucketIp, bucket] of rateLimitBuckets) {
      if (now - bucket.startedAt >= RATE_LIMIT_WINDOW_MS) rateLimitBuckets.delete(bucketIp);
    }
    if (rateLimitBuckets.size >= 10_000) rateLimitBuckets.delete(rateLimitBuckets.keys().next().value);
  }
  const bucket = rateLimitBuckets.get(ip);
  if (!bucket || now - bucket.startedAt >= RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(ip, { count: 1, startedAt: now });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON request.');
    error.statusCode = 400;
    throw error;
  }
}

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function normalizeInquiry(body) {
  const features = Array.isArray(body.features)
    ? body.features
    : body.features
      ? [body.features]
      : [];
  const inquiry = {
    name: cleanText(body.name, 120),
    email: cleanText(body.email, 254).toLowerCase(),
    phone: cleanText(body.phone, 40),
    business: cleanText(body.business, 160),
    industry: cleanText(body.industry, 160),
    currentWebsite: cleanText(body.current_website, 500),
    features: features.map((value) => cleanText(value, 100)).filter(Boolean).slice(0, 20),
    budget: cleanText(body.budget, 100),
    timeline: cleanText(body.timeline, 100),
    details: cleanText(body.details, 5000),
    referral: cleanText(body.referral, 120),
  };

  if (!inquiry.name) throw Object.assign(new Error('Please enter your name.'), { statusCode: 400 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inquiry.email)) {
    throw Object.assign(new Error('Please enter a valid email address.'), { statusCode: 400 });
  }
  return inquiry;
}

async function verifyTurnstile(token, clientIp) {
  if (!token) return { success: false, 'error-codes': ['missing-input-response'] };

  const body = new URLSearchParams({
    secret: TURNSTILE_SECRET_KEY,
    response: token,
    remoteip: clientIp,
    idempotency_key: randomUUID(),
  });
  const verificationResponse = await fetch(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!verificationResponse.ok) throw new Error(`Turnstile returned HTTP ${verificationResponse.status}`);
  return verificationResponse.json();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function inquiryRows(inquiry) {
  return [
    ['Name', inquiry.name],
    ['Email', inquiry.email],
    ['Phone', inquiry.phone || 'Not provided'],
    ['Business', inquiry.business || 'Not provided'],
    ['Industry', inquiry.industry || 'Not provided'],
    ['Current website', inquiry.currentWebsite || 'Not provided'],
    ['Requested features', inquiry.features.join(', ') || 'Not provided'],
    ['Budget', inquiry.budget || 'Not provided'],
    ['Timeline', inquiry.timeline || 'Not provided'],
    ['Referral', inquiry.referral || 'Not provided'],
    ['Project details', inquiry.details || 'Not provided'],
  ];
}

function buildEmail(inquiry, inquiryId, createdAt) {
  const rows = inquiryRows(inquiry);
  const subjectBusiness = inquiry.business || inquiry.name;
  return {
    from: process.env.SMTP_FROM || 'Custom For All <local-test@localhost>',
    to: INQUIRY_RECIPIENT,
    replyTo: inquiry.email,
    subject: `New website inquiry — ${subjectBusiness}`,
    text: [
      `Inquiry ID: ${inquiryId}`,
      `Received: ${createdAt}`,
      '',
      ...rows.map(([label, value]) => `${label}: ${value}`),
    ].join('\n'),
    html: `
      <h2>New Custom For All inquiry</h2>
      <p><strong>Inquiry ID:</strong> ${escapeHtml(inquiryId)}<br>
      <strong>Received:</strong> ${escapeHtml(createdAt)}</p>
      <table cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:720px">
        ${rows.map(([label, value]) => `
          <tr>
            <th align="left" valign="top" style="border-bottom:1px solid #ddd;width:170px">${escapeHtml(label)}</th>
            <td style="border-bottom:1px solid #ddd;white-space:pre-wrap">${escapeHtml(value)}</td>
          </tr>
        `).join('')}
      </table>
    `,
  };
}

async function handleInquiry(request, response) {
  const clientIp = getClientIp(request);
  if (isRateLimited(clientIp)) {
    return sendJson(response, 429, { ok: false, message: 'Too many requests. Please try again later.' }, {
      'Retry-After': String(RATE_LIMIT_WINDOW_MS / 1000),
    });
  }

  const body = await readJson(request);
  if (cleanText(body.website, 200)) return sendJson(response, 201, { ok: true });

  const inquiry = normalizeInquiry(body);
  let verification;
  try {
    verification = await verifyTurnstile(cleanText(body.turnstileToken, 2048), clientIp);
  } catch (error) {
    console.error('Turnstile request failed:', error.message);
    return sendJson(response, 503, { ok: false, message: 'Security verification is temporarily unavailable. Please try again.' });
  }

  const hostname = cleanText(verification.hostname, 255).toLowerCase();
  const hostnameAllowed = !IS_PRODUCTION || TURNSTILE_ALLOWED_HOSTNAMES.has(hostname);
  if (!verification.success || !hostnameAllowed) {
    console.warn('Turnstile rejected submission:', verification['error-codes'] || [], hostname || 'unknown');
    return sendJson(response, 400, { ok: false, message: 'Security verification failed. Please try again.' });
  }

  const inquiryId = randomUUID();
  const createdAt = new Date().toISOString();
  insertInquiry.run(
    inquiryId,
    createdAt,
    inquiry.name,
    inquiry.email,
    inquiry.phone,
    inquiry.business,
    inquiry.industry,
    inquiry.currentWebsite,
    JSON.stringify(inquiry.features),
    inquiry.budget,
    inquiry.timeline,
    inquiry.details,
    inquiry.referral,
    hostname,
    'pending',
    '',
    '',
  );

  try {
    const mailResult = await mailer.sendMail(buildEmail(inquiry, inquiryId, createdAt));
    const messageId = cleanText(mailResult.messageId, 500);
    updateDelivery.run(smtpConfigured ? 'sent' : 'test', messageId, '', inquiryId);
    console.info(`Inquiry ${inquiryId} stored; email status=${smtpConfigured ? 'sent' : 'test'} messageId=${messageId}`);
    return sendJson(response, 201, { ok: true, inquiryId, delivery: smtpConfigured ? 'sent' : 'test' });
  } catch (error) {
    updateDelivery.run('failed', '', cleanText(error.message, 1000), inquiryId);
    console.error(`Inquiry ${inquiryId} stored; email failed:`, error.message);
    return sendJson(response, 202, { ok: true, inquiryId, delivery: 'stored' });
  }
}

async function serveStatic(request, response, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const decodedPath = decodeURIComponent(requestedPath);
  const relativePath = normalize(decodedPath).replace(/^[/\\]+/, '');
  if (relativePath !== 'index.html' && !relativePath.startsWith('assets/')) {
    response.writeHead(404).end('Not found');
    return;
  }

  const filePath = join(PROJECT_ROOT, relativePath);
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': fileStat.size,
      'Cache-Control': relativePath === 'index.html' ? 'no-cache' : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/api/config') {
      return sendJson(response, 200, { turnstileSiteKey: TURNSTILE_SITE_KEY });
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(response, 200, {
        ok: true,
        database: true,
        smtp: smtpConfigured || !IS_PRODUCTION,
        turnstile: Boolean(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY),
      });
    }
    if (request.method === 'POST' && url.pathname === '/api/inquiries') {
      return await handleInquiry(request, response);
    }
    if (url.pathname.startsWith('/api/')) return sendJson(response, 404, { ok: false, message: 'Not found.' });
    if (request.method === 'GET' || request.method === 'HEAD') {
      return await serveStatic(request, response, url.pathname);
    }
    sendJson(response, 405, { ok: false, message: 'Method not allowed.' }, { Allow: 'GET, HEAD, POST' });
  } catch (error) {
    console.error('Request failed:', error);
    sendJson(response, error.statusCode || 500, {
      ok: false,
      message: error.statusCode ? error.message : 'Something went wrong. Please try again.',
    });
  }
});

server.listen(PORT, HOST, () => {
  console.info(`Custom For All listening on http://${HOST}:${PORT}`);
  console.info(`Inquiry database: ${databasePath}`);
  if (!smtpConfigured) console.info('SMTP is not configured; local submissions use Nodemailer JSON transport.');
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
