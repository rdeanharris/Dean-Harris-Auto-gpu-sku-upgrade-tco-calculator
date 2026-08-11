import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const ALLOW_DEV_AUTH = process.env.ALLOW_DEV_AUTH === "true";
const PUBLIC_API_BASE_URL = String(process.env.PUBLIC_API_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
const APP_REDIRECT_URI = String(process.env.APP_REDIRECT_URI || "").trim();
const EMAIL_DELIVERY_WEBHOOK_URL = String(process.env.EMAIL_DELIVERY_WEBHOOK_URL || "").trim();
const EMAIL_DELIVERY_BEARER_TOKEN = String(process.env.EMAIL_DELIVERY_BEARER_TOKEN || "").trim();
const EMAIL_FROM = String(process.env.EMAIL_FROM || "GPU TCO Access <no-reply@example.com>").trim();
const MAGIC_LINK_MINUTES = Math.max(5, Number(process.env.MAGIC_LINK_MINUTES || 30));
const INVITE_APPROVAL_HOURS = Math.max(1, Number(process.env.INVITE_APPROVAL_HOURS || 24));
const SESSION_HOURS = Math.max(1, Number(process.env.SESSION_HOURS || 12));
const COOKIE_AUTH_ENABLED = process.env.COOKIE_AUTH_ENABLED === "true";
const SESSION_COOKIE_NAME = String(process.env.SESSION_COOKIE_NAME || "autotco_session").trim();
const COOKIE_SECURE = process.env.COOKIE_SECURE !== "false";
const ADMIN_EMAILS = new Set(splitEnv(process.env.ADMIN_EMAILS || "deanh@nvidia.com"));
const REQUIRED_EMAIL_DOMAIN = String(process.env.REQUIRED_EMAIL_DOMAIN || "").trim().toLowerCase();
const ALLOWED_ORIGINS = new Set(splitEnv(process.env.ALLOWED_ORIGINS || "http://127.0.0.1:8767,http://localhost:8767"));
const PERSONAL_EMAIL_DOMAINS = new Set(splitEnv(process.env.BLOCKED_PERSONAL_EMAIL_DOMAINS || [
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com",
  "live.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
  "pm.me", "gmx.com", "mail.com", "zoho.com", "hey.com",
].join(",")));
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MS_GRAPH_TENANT_ID = String(process.env.MS_GRAPH_TENANT_ID || "").trim();
const MS_GRAPH_CLIENT_ID = String(process.env.MS_GRAPH_CLIENT_ID || "").trim();
const MS_GRAPH_CLIENT_SECRET = String(process.env.MS_GRAPH_CLIENT_SECRET || "").trim();
const MS_GRAPH_SENDER = String(process.env.MS_GRAPH_SENDER || "").trim();
const DATABRICKS_HOST = String(process.env.DATABRICKS_HOST || "https://nvidia-edsp-fdp-prd.cloud.databricks.com").replace(/\/+$/, "");
const DATABRICKS_TABLE = String(process.env.DATABRICKS_TABLE || "edsp_fdp_nala_fpa_prod.gpu_cloud_model.unified_dataset_automotive").trim();
const DATABRICKS_WAREHOUSE_ID = String(process.env.DATABRICKS_WAREHOUSE_ID || "").trim();
const DATABRICKS_TOKEN = String(process.env.DATABRICKS_TOKEN || "").trim();
const DATABRICKS_SQL = String(process.env.DATABRICKS_SQL || "").trim();
const DATABRICKS_SKU_COLUMN = String(process.env.DATABRICKS_SKU_COLUMN || "").trim();
const DATABRICKS_PRICE_COLUMN = String(process.env.DATABRICKS_PRICE_COLUMN || "").trim();
const DATABRICKS_PROVIDER_COLUMN = String(process.env.DATABRICKS_PROVIDER_COLUMN || "").trim();
const DATABRICKS_MAX_ROWS = Math.min(50000, Math.max(1, Number(process.env.DATABRICKS_MAX_ROWS || 10000)));
const DATABRICKS_CACHE_MINUTES = Math.max(1, Number(process.env.DATABRICKS_CACHE_MINUTES || 60));
const rateBuckets = new Map();
let storeQueue = Promise.resolve();
let cloudPriceCache = null;

function splitEnv(value) {
  return String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function emptyStore() {
  return {
    configs: [],
    activity: [],
    registrationRequests: [],
    users: [],
    magicLinks: [],
    exchangeCodes: [],
    sessions: [],
    inviteApprovalLinks: [],
  };
}

function normalizeStore(value) {
  const fallback = emptyStore();
  for (const key of Object.keys(fallback)) {
    fallback[key] = Array.isArray(value?.[key]) ? value[key] : fallback[key];
  }
  return fallback;
}

async function readStore() {
  try {
    return normalizeStore(JSON.parse(await fs.readFile(STORE_FILE, "utf8")));
  } catch {
    return emptyStore();
  }
}

async function writeStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.rename(temporary, STORE_FILE);
}

async function mutateStore(callback) {
  const operation = storeQueue.then(async () => {
    const store = cleanupExpired(await readStore());
    const result = await callback(store);
    await writeStore(store);
    return result;
  });
  storeQueue = operation.catch(() => {});
  return operation;
}

function allowedOrigin(req) {
  const origin = String(req.headers.origin || "");
  if (!origin) return "";
  return ALLOWED_ORIGINS.has(origin.toLowerCase()) ? origin : "";
}

function corsHeaders(req) {
  const origin = allowedOrigin(req);
  return {
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    ...(origin ? { "Access-Control-Allow-Credentials": "true" } : {}),
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

function sendJson(req, res, status, payload) {
  const body = status === 204 ? "" : JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(req) });
  res.end(body);
}

function sendRedirect(req, res, location, extraHeaders = {}) {
  res.writeHead(302, { Location: location, ...corsHeaders(req), ...extraHeaders });
  res.end();
}

function parseCookies(req) {
  return String(req.headers.cookie || "").split(";").reduce((cookies, part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return cookies;
    const key = part.slice(0, separator).trim();
    if (!key) return cookies;
    cookies[key] = decodeURIComponent(part.slice(separator + 1).trim());
    return cookies;
  }, {});
}

function sessionCookie(token, maxAgeSeconds) {
  const secure = COOKIE_SECURE ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, maxAgeSeconds)}${secure}`;
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 });
  }
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function companyEmailValidation(value) {
  const email = normalizeEmail(value);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, email, error: "Enter a valid company email address." };
  const domain = email.split("@")[1];
  if (PERSONAL_EMAIL_DOMAINS.has(domain)) return { ok: false, email, error: "Personal email domains are not allowed." };
  if (REQUIRED_EMAIL_DOMAIN && domain !== REQUIRED_EMAIL_DOMAIN) return { ok: false, email, error: `Email must use the ${REQUIRED_EMAIL_DOMAIN} domain.` };
  return { ok: true, email, domain };
}

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function expiresAt(milliseconds) {
  return new Date(Date.now() + milliseconds).toISOString();
}

function cleanupExpired(store) {
  const now = Date.now();
  store.magicLinks = store.magicLinks.filter((item) => !item.usedAt && Date.parse(item.expiresAt) > now);
  store.exchangeCodes = store.exchangeCodes.filter((item) => !item.usedAt && Date.parse(item.expiresAt) > now);
  store.sessions = store.sessions.filter((item) => !item.revokedAt && Date.parse(item.expiresAt) > now);
  store.inviteApprovalLinks = store.inviteApprovalLinks.filter((item) => !item.usedAt && Date.parse(item.expiresAt) > now);
  return store;
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function rateLimit(req, key, limit, windowMinutes) {
  const bucketKey = `${clientIp(req)}:${key}`;
  const now = Date.now();
  const windowMs = windowMinutes * 60 * 1000;
  const bucket = rateBuckets.get(bucketKey) || [];
  const recent = bucket.filter((timestamp) => timestamp > now - windowMs);
  if (recent.length >= limit) return false;
  recent.push(now);
  rateBuckets.set(bucketKey, recent);
  return true;
}

function addActivity(store, actorEmail, action, detail = {}) {
  store.activity.unshift({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    userEmail: normalizeEmail(actorEmail) || "anonymous",
    action,
    detail,
  });
  store.activity = store.activity.slice(0, 5000);
}

function userForEmail(store, email) {
  return store.users.find((user) => user.email === normalizeEmail(email));
}

function upsertUser(store, values) {
  const email = normalizeEmail(values.email);
  const current = userForEmail(store, email);
  const next = {
    id: current?.id || crypto.randomUUID(),
    email,
    company: String(values.company ?? current?.company ?? "").slice(0, 160),
    status: values.status || current?.status || "pending",
    role: ADMIN_EMAILS.has(email) ? "admin" : (values.role || current?.role || "user"),
    createdAt: current?.createdAt || new Date().toISOString(),
    approvedAt: values.approvedAt ?? current?.approvedAt ?? null,
    approvedBy: values.approvedBy ?? current?.approvedBy ?? null,
    deniedAt: values.deniedAt ?? current?.deniedAt ?? null,
    lastActiveAt: values.lastActiveAt ?? current?.lastActiveAt ?? null,
    loginCount: Number(current?.loginCount || 0),
  };
  store.users = store.users.filter((user) => user.email !== email);
  store.users.unshift(next);
  return next;
}

async function deliverAccessEmail({ email, company, magicUrl, expiresMinutes }) {
  const subject = "Your approved GPU TCO calculator access link";
  const text = [
    `Access for ${email}${company ? ` (${company})` : ""} has been approved.`,
    `Open this one-time link within ${expiresMinutes} minutes:`,
    magicUrl,
    "If you did not request access, ignore this message.",
  ].join("\n\n");
  const html = `<p>Access for <strong>${escapeHtml(email)}</strong> has been approved.</p><p><a href="${escapeHtml(magicUrl)}">Open the GPU TCO calculator</a></p><p>This one-time link expires in ${expiresMinutes} minutes. If you did not request access, ignore this message.</p>`;
  const delivery = await deliverEmail({ to: email, subject, text, html });
  if (!delivery.delivered && ALLOW_DEV_AUTH) return { ...delivery, devMagicLink: magicUrl };
  return delivery;
}

async function deliverApprovalEmail({ adminEmail, invitedEmail, company, requestedBy, approvalUrl, expiresHours }) {
  const subject = `Approve GPU TCO calculator access for ${invitedEmail}`;
  const text = [
    `${requestedBy} invited ${invitedEmail}${company ? ` (${company})` : ""} to use the GPU TCO calculator.`,
    `Approve this request within ${expiresHours} hours:`,
    approvalUrl,
    "The customer will receive their secure access link only after you approve.",
  ].join("\n\n");
  const html = `<p><strong>${escapeHtml(requestedBy)}</strong> invited <strong>${escapeHtml(invitedEmail)}</strong>${company ? ` (${escapeHtml(company)})` : ""}.</p><p><a href="${escapeHtml(approvalUrl)}">Approve customer access</a></p><p>This approval link expires in ${expiresHours} hours. The customer receives access only after approval.</p>`;
  const delivery = await deliverEmail({ to: adminEmail, subject, text, html });
  if (!delivery.delivered && ALLOW_DEV_AUTH) return { ...delivery, devApprovalLink: approvalUrl };
  return delivery;
}

async function deliverEmail({ to, subject, text, html }) {
  if (EMAIL_DELIVERY_WEBHOOK_URL) {
    const response = await fetch(EMAIL_DELIVERY_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(EMAIL_DELIVERY_BEARER_TOKEN ? { Authorization: `Bearer ${EMAIL_DELIVERY_BEARER_TOKEN}` } : {}),
      },
      body: JSON.stringify({ to, from: EMAIL_FROM, subject, text, html }),
    });
    if (!response.ok) throw Object.assign(new Error("Email delivery failed."), { status: 502 });
    return { delivered: true, provider: "webhook" };
  }

  if (MS_GRAPH_TENANT_ID && MS_GRAPH_CLIENT_ID && MS_GRAPH_CLIENT_SECRET && MS_GRAPH_SENDER) {
    const tokenResponse = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(MS_GRAPH_TENANT_ID)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: MS_GRAPH_CLIENT_ID,
        client_secret: MS_GRAPH_CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    });
    if (!tokenResponse.ok) throw Object.assign(new Error("Microsoft Graph authentication failed."), { status: 502 });
    const tokenPayload = await tokenResponse.json();
    const graphResponse = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MS_GRAPH_SENDER)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenPayload.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "HTML", content: html || `<pre>${escapeHtml(text)}</pre>` },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: true,
      }),
    });
    if (!graphResponse.ok) throw Object.assign(new Error("Microsoft Graph email delivery failed."), { status: 502 });
    return { delivered: true, provider: "microsoft-graph" };
  }

  if (ALLOW_DEV_AUTH) return { delivered: false, provider: "development" };
  throw Object.assign(new Error("Email delivery is not configured."), { status: 503 });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
}

function createMagicLinkRecord(store, user, reason) {
  const rawToken = randomToken();
  store.magicLinks = store.magicLinks.filter((item) => item.email !== user.email);
  store.magicLinks.push({
    id: crypto.randomUUID(),
    email: user.email,
    tokenHash: hashToken(rawToken),
    reason,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt(MAGIC_LINK_MINUTES * 60 * 1000),
    usedAt: null,
  });
  return `${PUBLIC_API_BASE_URL}/auth/magic?token=${encodeURIComponent(rawToken)}`;
}

function createSessionRecord(store, user) {
  const rawToken = randomToken();
  const session = {
    id: crypto.randomUUID(), email: user.email, tokenHash: hashToken(rawToken),
    createdAt: new Date().toISOString(), expiresAt: expiresAt(SESSION_HOURS * 60 * 60 * 1000), revokedAt: null,
  };
  store.sessions.push(session);
  user.lastActiveAt = new Date().toISOString();
  user.loginCount = Number(user.loginCount || 0) + 1;
  addActivity(store, user.email, "login", { sessionId: session.id });
  return { rawToken, session };
}

function createInviteApprovalRecord(store, request, requestedBy) {
  const rawToken = randomToken();
  store.inviteApprovalLinks = store.inviteApprovalLinks.filter((item) => item.requestId !== request.id);
  store.inviteApprovalLinks.push({
    id: crypto.randomUUID(), requestId: request.id, requestedBy,
    tokenHash: hashToken(rawToken), createdAt: new Date().toISOString(),
    expiresAt: expiresAt(INVITE_APPROVAL_HOURS * 60 * 60 * 1000), usedAt: null,
  });
  return `${PUBLIC_API_BASE_URL}/admin/approve-invite?token=${encodeURIComponent(rawToken)}`;
}

function routeInfo(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return { method: req.method, pathname: url.pathname, searchParams: url.searchParams };
}

function devUserFromHeaders(req) {
  if (!ALLOW_DEV_AUTH) return null;
  const validation = companyEmailValidation(req.headers["x-dev-user-email"]);
  if (!validation.ok) return null;
  return { email: validation.email, role: ADMIN_EMAILS.has(validation.email) ? "admin" : "user", isAdmin: ADMIN_EMAILS.has(validation.email) };
}

async function userFromRequest(req, store) {
  const devUser = devUserFromHeaders(req);
  if (devUser) return devUser;
  const authorization = String(req.headers.authorization || "");
  const cookieToken = parseCookies(req)[SESSION_COOKIE_NAME] || "";
  const rawToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : cookieToken;
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const session = store.sessions.find((item) => item.tokenHash === tokenHash && !item.revokedAt && Date.parse(item.expiresAt) > Date.now());
  if (!session) return null;
  const user = userForEmail(store, session.email);
  if (!user || user.status !== "approved") return null;
  return { ...user, isAdmin: user.role === "admin" || ADMIN_EMAILS.has(user.email), sessionId: session.id };
}

function requireAdmin(req, res, user) {
  if (user?.isAdmin) return true;
  sendJson(req, res, 403, { error: "Admin access required." });
  return false;
}

function groupedConfigs(configs) {
  return configs.reduce((groups, config) => {
    (groups[config.ownerEmail] ||= []).push(config);
    return groups;
  }, {});
}

function usageStats(store) {
  const now = Date.now();
  const active7Cutoff = now - 7 * 24 * 60 * 60 * 1000;
  const active30Cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const loginEvents = store.activity.filter((item) => item.action === "login");
  const activeEmailsSince = (cutoff) => new Set(loginEvents.filter((item) => Date.parse(item.timestamp) >= cutoff).map((item) => item.userEmail)).size;
  const approvedUsers = store.users.filter((user) => user.status === "approved");
  const userFrequency = approvedUsers.map((user) => {
    const logins = loginEvents.filter((item) => item.userEmail === user.email).map((item) => Date.parse(item.timestamp)).filter(Number.isFinite).sort((a, b) => a - b);
    const gaps = logins.slice(1).map((timestamp, index) => (timestamp - logins[index]) / (24 * 60 * 60 * 1000));
    return {
      email: user.email,
      company: user.company,
      loginCount: logins.length,
      lastLoginAt: logins.length ? new Date(logins[logins.length - 1]).toISOString() : null,
      averageDaysBetweenLogins: gaps.length ? Math.round((gaps.reduce((sum, value) => sum + value, 0) / gaps.length) * 10) / 10 : null,
    };
  });
  return {
    invitationsRequested: store.activity.filter((item) => item.action === "request_access" || item.action === "invite_user").length,
    pendingApprovals: store.registrationRequests.filter((request) => request.status === "pending").length,
    approvedUsers: approvedUsers.length,
    totalLogins: loginEvents.length,
    activeUsers: activeEmailsSince(active30Cutoff),
    activeUsers7Days: activeEmailsSince(active7Cutoff),
    activeUsers30Days: activeEmailsSince(active30Cutoff),
    returningUsers: userFrequency.filter((item) => item.loginCount > 1).length,
    configurationsSaved: store.activity.filter((item) => item.action === "save_config").length,
    configurationsLoaded: store.activity.filter((item) => item.action === "load_config").length,
    pdfExports: store.activity.filter((item) => item.action === "pdf_export").length,
    lastActivityAt: store.activity[0]?.timestamp || null,
    userFrequency,
  };
}

function normalizedColumnName(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function findColumn(columns, configured, candidates) {
  const normalized = new Map(columns.map((column, index) => [normalizedColumnName(column.name), index]));
  if (configured) {
    const index = normalized.get(normalizedColumnName(configured));
    if (index === undefined) throw Object.assign(new Error(`Configured Databricks column not found: ${configured}`), { status: 502 });
    return index;
  }
  for (const candidate of candidates) {
    const index = normalized.get(normalizedColumnName(candidate));
    if (index !== undefined) return index;
  }
  return -1;
}

function canonicalCloudSku(value) {
  const raw = String(value || "").trim();
  const key = raw.toUpperCase().replace(/NVIDIA/g, " ").replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  if (!key) return "";
  if (key.includes("GB300")) return "GB300 NVL72";
  if (key.includes("GB200")) return "GB200 NVL72";
  if (key.includes("B300")) return "B300 270GB SXM";
  if (key.includes("B200")) return "B200 180GB SXM";
  if (key.includes("B100")) return "B100";
  if (key.includes("GH200")) return "GH200 96GB";
  if (key.includes("H200")) return "H200 141GB SXM";
  if (key.includes("H100") && key.includes("NVL")) return "H100 NVL 94GB";
  if (key.includes("H100") && key.includes("PCIE")) return "H100 80GB PCIe";
  if (key.includes("H100")) return "H100 80GB SXM";
  if (key.includes("H800")) return "H800 80GB SXM";
  if (/\bH20\b/.test(key)) return "H20 96GB SXM";
  if (key.includes("A100") && key.includes("40") && key.includes("PCIE")) return "A100 40GB PCIe";
  if (key.includes("A100") && key.includes("40")) return "A100 40GB SXM";
  if (key.includes("A100") && key.includes("80") && key.includes("PCIE")) return "A100 80GB PCIe";
  if (key.includes("A100")) return "A100 80GB SXM";
  if (key.includes("A800") && key.includes("PCIE")) return "A800 80GB PCIe";
  if (key.includes("A800")) return "A800 80GB SXM";
  if (key.includes("A6000")) return "A6000 48GB";
  if (/\bA40\b/.test(key)) return "A40 48GB";
  if (/\bA30\b/.test(key)) return "A30 24GB";
  if (/\bA10\b/.test(key)) return "A10 24GB";
  if (/\bA2\b/.test(key)) return "A2 16GB";
  if (key.includes("L40S")) return "L40S 48GB";
  if (/\bL40\b/.test(key)) return "L40 48GB";
  if (/\bL20\b/.test(key)) return "L20 48GB PCIe";
  if (/\bL4\b/.test(key)) return "L4 24GB";
  if (/\bL2\b/.test(key)) return "L2 24GB PCIe";
  if (key.includes("RTX PRO 6000") && key.includes("BLACKWELL")) return "RTX PRO 6000 Blackwell Server Edition";
  if (/\bRTXD\b/.test(key) || key.includes("RTX 6000 D")) return "RTXD";
  if (key.includes("RTX 6000") && key.includes("ADA")) return "RTX 6000 Ada 48GB";
  if (key.includes("QUADRO RTX 6000")) return "Quadro RTX 6000 24GB";
  if (/\bT4\b/.test(key)) return "T4 16GB";
  if (key.includes("V100") && key.includes("32")) return "Tesla V100 32GB";
  if (key.includes("V100")) return "Tesla V100 16GB";
  if (key.includes("P100")) return "P100 16GB";
  return raw;
}

function numericPrice(value) {
  const parsed = Number(String(value ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function databricksStatementSql() {
  if (DATABRICKS_SQL) return DATABRICKS_SQL;
  if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(DATABRICKS_TABLE)) {
    throw Object.assign(new Error("DATABRICKS_TABLE must be a three-part catalog.schema.table name."), { status: 500 });
  }
  return `SELECT * FROM ${DATABRICKS_TABLE} LIMIT ${DATABRICKS_MAX_ROWS}`;
}

async function databricksRequest(pathname, options = {}) {
  const response = await fetch(`${DATABRICKS_HOST}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${DATABRICKS_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.message || payload.error || `Databricks request failed (${response.status}).`;
    throw Object.assign(new Error(message), { status: 502 });
  }
  return payload;
}

async function runDatabricksStatement() {
  if (!DATABRICKS_WAREHOUSE_ID || !DATABRICKS_TOKEN) {
    throw Object.assign(new Error("Databricks cloud pricing is configured but requires DATABRICKS_WAREHOUSE_ID and DATABRICKS_TOKEN on the TCO API server."), { status: 503 });
  }
  let statement = await databricksRequest("/api/2.0/sql/statements", {
    method: "POST",
    body: JSON.stringify({
      warehouse_id: DATABRICKS_WAREHOUSE_ID,
      statement: databricksStatementSql(),
      wait_timeout: "30s",
      on_wait_timeout: "CONTINUE",
      disposition: "INLINE",
      format: "JSON_ARRAY",
    }),
  });
  const statementId = statement.statement_id;
  for (let attempt = 0; statement.status?.state === "PENDING" || statement.status?.state === "RUNNING"; attempt += 1) {
    if (attempt >= 30) throw Object.assign(new Error("Databricks cloud pricing query timed out."), { status: 504 });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    statement = await databricksRequest(`/api/2.0/sql/statements/${encodeURIComponent(statementId)}`);
  }
  if (statement.status?.state !== "SUCCEEDED") {
    throw Object.assign(new Error(statement.status?.error?.message || `Databricks statement ended in ${statement.status?.state || "an unknown state"}.`), { status: 502 });
  }
  const rows = [...(statement.result?.data_array || [])];
  let nextLink = statement.result?.next_chunk_internal_link;
  while (nextLink) {
    const chunk = await databricksRequest(nextLink);
    rows.push(...(chunk.data_array || []));
    nextLink = chunk.next_chunk_internal_link;
  }
  return { columns: statement.manifest?.schema?.columns || [], rows };
}

function normalizeCloudPriceRows(columns, rows) {
  const skuIndex = findColumn(columns, DATABRICKS_SKU_COLUMN, [
    "gpu_sku", "nvidia_gpu_sku", "gpu_model", "gpu_name", "accelerator_name", "product_name", "product", "sku",
  ]);
  const priceIndex = findColumn(columns, DATABRICKS_PRICE_COLUMN, [
    "average_price_per_gpu_hour", "avg_price_per_gpu_hour", "price_per_gpu_hour", "dollars_per_gpu_hour",
    "average_gpu_hourly_price", "avg_gpu_hourly_price", "gpu_hourly_price", "hourly_price_per_gpu",
    "average_price", "avg_price",
  ]);
  const providerIndex = findColumn(columns, DATABRICKS_PROVIDER_COLUMN, [
    "cloud_provider", "provider_name", "provider", "csp", "vendor",
  ]);
  if (skuIndex < 0 || priceIndex < 0) {
    const available = columns.map((column) => column.name).join(", ");
    throw Object.assign(new Error(`Unable to identify Databricks SKU/price columns. Available columns: ${available}`), { status: 502 });
  }
  const grouped = new Map();
  rows.forEach((row) => {
    const sku = canonicalCloudSku(row[skuIndex]);
    const price = numericPrice(row[priceIndex]);
    if (!sku || price === null) return;
    const entry = grouped.get(sku) || { sku, prices: [], providers: new Set() };
    entry.prices.push(price);
    if (providerIndex >= 0 && row[providerIndex]) entry.providers.add(String(row[providerIndex]).trim());
    grouped.set(sku, entry);
  });
  return Object.fromEntries([...grouped.values()].map((entry) => {
    const average = entry.prices.reduce((sum, value) => sum + value, 0) / entry.prices.length;
    return [entry.sku, {
      sku: entry.sku,
      dollarsPerGpuHour: Math.round(average * 10000) / 10000,
      sampleCount: entry.prices.length,
      providers: [...entry.providers].sort(),
      source: `${DATABRICKS_HOST} / ${DATABRICKS_TABLE}`,
    }];
  }));
}

async function currentCloudPrices(forceRefresh = false) {
  const maxAgeMs = DATABRICKS_CACHE_MINUTES * 60 * 1000;
  if (!forceRefresh && cloudPriceCache && Date.now() - cloudPriceCache.cachedAtMs < maxAgeMs) return cloudPriceCache.payload;
  const { columns, rows } = await runDatabricksStatement();
  const prices = normalizeCloudPriceRows(columns, rows);
  const payload = {
    source: { host: DATABRICKS_HOST, table: DATABRICKS_TABLE, refreshedAt: new Date().toISOString() },
    prices,
    skuCount: Object.keys(prices).length,
    rowCount: rows.length,
  };
  cloudPriceCache = { cachedAtMs: Date.now(), payload };
  return payload;
}

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    if (req.headers.origin && !allowedOrigin(req)) return sendJson(req, res, 403, { error: "Origin not allowed." });
    return sendJson(req, res, 204, {});
  }
  if (req.headers.origin && !allowedOrigin(req)) return sendJson(req, res, 403, { error: "Origin not allowed." });
  const { method, pathname, searchParams } = routeInfo(req);

  if (method === "GET" && pathname === "/health") {
    return sendJson(req, res, 200, { ok: true, service: "tco-config-api", auth: "approved-email-magic-link" });
  }

  if (method === "POST" && pathname === "/registration-requests") {
    if (!rateLimit(req, "registration", 5, 15)) return sendJson(req, res, 429, { error: "Too many requests. Try again later." });
    const body = await readJson(req);
    const validation = companyEmailValidation(body.email);
    if (!validation.ok) return sendJson(req, res, 400, { error: validation.error });
    const company = String(body.company || "").trim().slice(0, 160);
    if (!company) return sendJson(req, res, 400, { error: "Company name is required." });
    let delivery = null;
    await mutateStore(async (store) => {
      const adminBootstrap = ADMIN_EMAILS.has(validation.email);
      const currentUser = userForEmail(store, validation.email);
      const status = adminBootstrap || currentUser?.status === "approved" ? "approved" : "pending";
      const user = upsertUser(store, {
        email: validation.email,
        company,
        status,
        approvedAt: status === "approved" ? (currentUser?.approvedAt || new Date().toISOString()) : null,
        approvedBy: status === "approved" ? (currentUser?.approvedBy || "admin-bootstrap") : null,
      });
      let request = store.registrationRequests.find((item) => item.email === validation.email && item.status === "pending");
      if (!request && status === "pending") {
        request = {
          id: crypto.randomUUID(), email: validation.email, company, status: "pending",
          tool: String(body.tool || "GPU_RA_and_NVAIE_TCO_Analysis").slice(0, 120), requestedAt: new Date().toISOString(),
          requestedBy: validation.email,
        };
        store.registrationRequests.unshift(request);
      }
      addActivity(store, validation.email, "request_access", { company, status });
      if (status === "approved") {
        const magicUrl = createMagicLinkRecord(store, user, "registration");
        delivery = await deliverAccessEmail({ email: user.email, company: user.company, magicUrl, expiresMinutes: MAGIC_LINK_MINUTES });
      } else if (request) {
        request.company = company;
        const approvalUrl = createInviteApprovalRecord(store, request, validation.email);
        const adminEmail = [...ADMIN_EMAILS][0];
        delivery = await deliverApprovalEmail({
          adminEmail, invitedEmail: validation.email, company, requestedBy: validation.email,
          approvalUrl, expiresHours: INVITE_APPROVAL_HOURS,
        });
      }
    });
    return sendJson(req, res, 202, {
      message: "If the address is eligible, the request is pending approval or an access link has been sent.",
      ...(ALLOW_DEV_AUTH && delivery?.devMagicLink ? { devMagicLink: delivery.devMagicLink } : {}),
      ...(ALLOW_DEV_AUTH && delivery?.devApprovalLink ? { devApprovalLink: delivery.devApprovalLink } : {}),
    });
  }

  if (method === "POST" && pathname === "/auth/request-link") {
    if (!rateLimit(req, "magic-link", 5, 15)) return sendJson(req, res, 429, { error: "Too many requests. Try again later." });
    const body = await readJson(req);
    const validation = companyEmailValidation(body.email);
    if (!validation.ok) return sendJson(req, res, 202, { message: "If the account is approved, an access link has been sent." });
    let delivery = null;
    await mutateStore(async (store) => {
      const user = userForEmail(store, validation.email);
      if (!user || user.status !== "approved") {
        addActivity(store, validation.email, "request_login_link_unapproved");
        return;
      }
      const magicUrl = createMagicLinkRecord(store, user, "login");
      delivery = await deliverAccessEmail({ email: user.email, company: user.company, magicUrl, expiresMinutes: MAGIC_LINK_MINUTES });
      addActivity(store, user.email, "request_login_link");
    });
    return sendJson(req, res, 202, {
      message: "If the account is approved, an access link has been sent.",
      ...(ALLOW_DEV_AUTH && delivery?.devMagicLink ? { devMagicLink: delivery.devMagicLink } : {}),
    });
  }

  if (method === "GET" && pathname === "/auth/magic") {
    if (!APP_REDIRECT_URI) return sendJson(req, res, 503, { error: "APP_REDIRECT_URI is not configured." });
    const tokenHash = hashToken(searchParams.get("token") || "");
    let exchangeCode = null;
    let cookieSession = null;
    await mutateStore(async (store) => {
      const link = store.magicLinks.find((item) => item.tokenHash === tokenHash && !item.usedAt && Date.parse(item.expiresAt) > Date.now());
      const user = link && userForEmail(store, link.email);
      if (!link || !user || user.status !== "approved") throw Object.assign(new Error("This access link is invalid or expired."), { status: 401 });
      link.usedAt = new Date().toISOString();
      if (COOKIE_AUTH_ENABLED) {
        cookieSession = createSessionRecord(store, user);
        addActivity(store, user.email, "consume_magic_link");
        return;
      }
      exchangeCode = randomToken(24);
      store.exchangeCodes.push({
        id: crypto.randomUUID(), email: user.email, codeHash: hashToken(exchangeCode),
        createdAt: new Date().toISOString(), expiresAt: expiresAt(5 * 60 * 1000), usedAt: null,
      });
      addActivity(store, user.email, "consume_magic_link");
    });
    if (COOKIE_AUTH_ENABLED && cookieSession) {
      return sendRedirect(req, res, APP_REDIRECT_URI, {
        "Set-Cookie": sessionCookie(cookieSession.rawToken, SESSION_HOURS * 60 * 60),
      });
    }
    const redirect = new URL(APP_REDIRECT_URI);
    redirect.searchParams.set("access_code", exchangeCode);
    return sendRedirect(req, res, redirect.toString());
  }

  if (method === "GET" && pathname === "/admin/approve-invite") {
    const tokenHash = hashToken(searchParams.get("token") || "");
    let approvedEmail = "";
    await mutateStore(async (store) => {
      const approval = store.inviteApprovalLinks.find((item) => item.tokenHash === tokenHash && !item.usedAt && Date.parse(item.expiresAt) > Date.now());
      const request = approval && store.registrationRequests.find((item) => item.id === approval.requestId && item.status === "pending");
      if (!approval || !request) throw Object.assign(new Error("This invite approval link is invalid or expired."), { status: 401 });
      approval.usedAt = new Date().toISOString();
      request.status = "approved";
      request.reviewedAt = new Date().toISOString();
      request.reviewedBy = "email-approval";
      approvedEmail = request.email;
      const approvedUser = upsertUser(store, {
        email: request.email, company: request.company, status: "approved",
        approvedAt: request.reviewedAt, approvedBy: "email-approval",
      });
      addActivity(store, "email-approval", "approve_invited_user", { email: request.email, requestedBy: approval.requestedBy });
      const magicUrl = createMagicLinkRecord(store, approvedUser, "invite-approval");
      await deliverAccessEmail({ email: approvedUser.email, company: approvedUser.company, magicUrl, expiresMinutes: MAGIC_LINK_MINUTES });
    });
    if (APP_REDIRECT_URI) {
      const redirect = new URL(APP_REDIRECT_URI);
      redirect.searchParams.set("invite_approved", approvedEmail);
      return sendRedirect(req, res, redirect.toString());
    }
    return sendJson(req, res, 200, { message: `Approved ${approvedEmail}. Their access email has been sent.` });
  }

  if (method === "POST" && pathname === "/auth/exchange") {
    const body = await readJson(req);
    const codeHash = hashToken(body.code || "");
    let responsePayload;
    await mutateStore(async (store) => {
      const code = store.exchangeCodes.find((item) => item.codeHash === codeHash && !item.usedAt && Date.parse(item.expiresAt) > Date.now());
      const user = code && userForEmail(store, code.email);
      if (!code || !user || user.status !== "approved") throw Object.assign(new Error("Access code is invalid or expired."), { status: 401 });
      code.usedAt = new Date().toISOString();
      const { rawToken: rawSessionToken, session } = createSessionRecord(store, user);
      responsePayload = {
        token: rawSessionToken,
        expiresAt: session.expiresAt,
        user: { email: user.email, company: user.company, role: user.role, status: user.status },
      };
    });
    return sendJson(req, res, 200, responsePayload);
  }

  const store = cleanupExpired(await readStore());
  const user = await userFromRequest(req, store);
  if (!user) return sendJson(req, res, 401, { error: "Authentication required." });

  if (method === "GET" && pathname === "/auth/check") {
    return sendJson(req, res, 204, {});
  }

  if (method === "GET" && pathname === "/me") {
    return sendJson(req, res, 200, { email: user.email, company: user.company, role: user.role, isAdmin: user.isAdmin });
  }

  if (method === "GET" && pathname === "/cloud-prices") {
    const forceRefresh = searchParams.get("refresh") === "true" && user.isAdmin;
    return sendJson(req, res, 200, await currentCloudPrices(forceRefresh));
  }

  if (method === "POST" && pathname === "/invitation-requests") {
    if (!rateLimit(req, `invite:${user.email}`, 10, 60)) return sendJson(req, res, 429, { error: "Too many invitation requests. Try again later." });
    const body = await readJson(req);
    const validation = companyEmailValidation(body.email);
    if (!validation.ok) return sendJson(req, res, 400, { error: validation.error });
    const company = String(body.company || "").trim().slice(0, 160);
    if (!company) return sendJson(req, res, 400, { error: "Company name is required." });
    let delivery = null;
    await mutateStore(async (nextStore) => {
      const existingUser = userForEmail(nextStore, validation.email);
      if (existingUser?.status === "approved") throw Object.assign(new Error("This user already has approved access."), { status: 409 });
      upsertUser(nextStore, { email: validation.email, company, status: "pending" });
      let request = nextStore.registrationRequests.find((item) => item.email === validation.email && item.status === "pending");
      if (!request) {
        request = {
          id: crypto.randomUUID(), email: validation.email, company, status: "pending",
          tool: String(body.tool || "GPU_RA_and_NVAIE_TCO_Analysis").slice(0, 120),
          requestedAt: new Date().toISOString(), requestedBy: user.email,
        };
        nextStore.registrationRequests.unshift(request);
      } else {
        request.company = company;
        request.requestedBy = user.email;
      }
      const approvalUrl = createInviteApprovalRecord(nextStore, request, user.email);
      addActivity(nextStore, user.email, "invite_user", { email: validation.email, company, requestId: request.id });
      const adminEmail = [...ADMIN_EMAILS][0];
      delivery = await deliverApprovalEmail({ adminEmail, invitedEmail: validation.email, company, requestedBy: user.email, approvalUrl, expiresHours: INVITE_APPROVAL_HOURS });
    });
    return sendJson(req, res, 202, {
      message: "Invitation submitted. The administrator must approve it before customer access is sent.",
      ...(ALLOW_DEV_AUTH && delivery?.devApprovalLink ? { devApprovalLink: delivery.devApprovalLink } : {}),
    });
  }

  if (method === "POST" && pathname === "/auth/logout") {
    await mutateStore(async (nextStore) => {
      const session = nextStore.sessions.find((item) => item.id === user.sessionId);
      if (session) session.revokedAt = new Date().toISOString();
      addActivity(nextStore, user.email, "logout");
    });
    if (COOKIE_AUTH_ENABLED) {
      res.writeHead(204, { ...corsHeaders(req), "Set-Cookie": sessionCookie("", 0) });
      return res.end();
    }
    return sendJson(req, res, 204, {});
  }

  if (method === "GET" && pathname === "/configs") {
    return sendJson(req, res, 200, { configs: store.configs.filter((config) => config.ownerEmail === user.email) });
  }

  if (method === "POST" && pathname === "/configs") {
    const body = await readJson(req);
    if (!body.state || typeof body.state !== "object" || Array.isArray(body.state)) return sendJson(req, res, 400, { error: "Configuration state is required." });
    let saved;
    await mutateStore(async (nextStore) => {
      const existing = body.id && nextStore.configs.find((config) => config.id === body.id && config.ownerEmail === user.email);
      const now = new Date().toISOString();
      saved = {
        id: existing?.id || crypto.randomUUID(), ownerEmail: user.email,
        name: String(body.name || "Untitled configuration").trim().slice(0, 120) || "Untitled configuration",
        calculator: String(body.calculator || body.tool || "GPU_RA_and_NVAIE_TCO_Analysis").slice(0, 120),
        state: body.state, createdAt: existing?.createdAt || now, updatedAt: now,
      };
      nextStore.configs = nextStore.configs.filter((config) => config.id !== saved.id);
      nextStore.configs.unshift(saved);
      addActivity(nextStore, user.email, "save_config", { id: saved.id, name: saved.name, calculator: saved.calculator });
    });
    return sendJson(req, res, 200, { config: saved });
  }

  if (method === "POST" && pathname.startsWith("/configs/") && pathname.endsWith("/loaded")) {
    const id = pathname.split("/")[2];
    await mutateStore(async (nextStore) => addActivity(nextStore, user.email, "load_config", { id }));
    return sendJson(req, res, 204, {});
  }

  if (method === "DELETE" && pathname.startsWith("/configs/")) {
    const id = pathname.split("/").pop();
    let deleted = false;
    await mutateStore(async (nextStore) => {
      const before = nextStore.configs.length;
      nextStore.configs = nextStore.configs.filter((config) => !(config.id === id && config.ownerEmail === user.email));
      deleted = before !== nextStore.configs.length;
      addActivity(nextStore, user.email, "delete_config", { id, deleted });
    });
    return sendJson(req, res, 200, { deleted });
  }

  if (method === "GET" && pathname === "/admin/dashboard") {
    if (!requireAdmin(req, res, user)) return;
    return sendJson(req, res, 200, {
      pendingRegistrations: store.registrationRequests.filter((request) => request.status === "pending"),
      users: store.users.map(({ id, email, company, status, role, createdAt, approvedAt, approvedBy, lastActiveAt, loginCount }) => ({ id, email, company, status, role, createdAt, approvedAt, approvedBy, lastActiveAt, loginCount })),
      configsByUser: groupedConfigs(store.configs), activity: store.activity, usageStats: usageStats(store),
    });
  }

  const approvalMatch = pathname.match(/^\/admin\/registration-requests\/([^/]+)\/(approve|deny)$/);
  if (method === "POST" && approvalMatch) {
    if (!requireAdmin(req, res, user)) return;
    const [, requestId, decision] = approvalMatch;
    let delivery = null;
    let approvedEmail = "";
    await mutateStore(async (nextStore) => {
      const request = nextStore.registrationRequests.find((item) => item.id === requestId);
      if (!request || request.status !== "pending") throw Object.assign(new Error("Pending request not found."), { status: 404 });
      request.status = decision === "approve" ? "approved" : "denied";
      request.reviewedAt = new Date().toISOString();
      request.reviewedBy = user.email;
      approvedEmail = request.email;
      const nextUser = upsertUser(nextStore, {
        email: request.email, company: request.company, status: request.status,
        approvedAt: decision === "approve" ? request.reviewedAt : null,
        approvedBy: decision === "approve" ? user.email : null,
        deniedAt: decision === "deny" ? request.reviewedAt : null,
      });
      addActivity(nextStore, user.email, decision === "approve" ? "approve_user" : "deny_user", { email: request.email, requestId });
      if (decision === "approve") {
        const magicUrl = createMagicLinkRecord(nextStore, nextUser, "approval");
        delivery = await deliverAccessEmail({ email: nextUser.email, company: nextUser.company, magicUrl, expiresMinutes: MAGIC_LINK_MINUTES });
      }
    });
    return sendJson(req, res, 200, {
      email: approvedEmail, status: decision === "approve" ? "approved" : "denied",
      message: decision === "approve" ? "User approved and secure access link sent." : "Access request denied.",
      ...(ALLOW_DEV_AUTH && delivery?.devMagicLink ? { devMagicLink: delivery.devMagicLink } : {}),
    });
  }

  return sendJson(req, res, 404, { error: "Not found." });
}

http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = Number(error.status) || 500;
    if (status >= 500) console.error(error);
    sendJson(req, res, status, { error: status >= 500 ? "Server error." : error.message });
  });
}).listen(PORT, () => {
  console.log(`TCO config API listening on ${PORT}`);
});
