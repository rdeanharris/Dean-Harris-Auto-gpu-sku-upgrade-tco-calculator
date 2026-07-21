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
const SESSION_HOURS = Math.max(1, Number(process.env.SESSION_HOURS || 12));
const ADMIN_EMAILS = new Set(splitEnv(process.env.ADMIN_EMAILS || "deanh@nvidia.com"));
const REQUIRED_EMAIL_DOMAIN = String(process.env.REQUIRED_EMAIL_DOMAIN || "").trim().toLowerCase();
const ALLOWED_ORIGINS = new Set(splitEnv(process.env.ALLOWED_ORIGINS || "http://127.0.0.1:8767,http://localhost:8767"));
const PERSONAL_EMAIL_DOMAINS = new Set(splitEnv(process.env.BLOCKED_PERSONAL_EMAIL_DOMAINS || [
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com",
  "live.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
  "pm.me", "gmx.com", "mail.com", "zoho.com", "hey.com",
].join(",")));
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const rateBuckets = new Map();
let storeQueue = Promise.resolve();

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

function sendRedirect(req, res, location) {
  res.writeHead(302, { Location: location, ...corsHeaders(req) });
  res.end();
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
  if (!EMAIL_DELIVERY_WEBHOOK_URL) {
    if (ALLOW_DEV_AUTH) return { delivered: false, devMagicLink: magicUrl };
    throw Object.assign(new Error("Email delivery is not configured."), { status: 503 });
  }
  const response = await fetch(EMAIL_DELIVERY_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(EMAIL_DELIVERY_BEARER_TOKEN ? { Authorization: `Bearer ${EMAIL_DELIVERY_BEARER_TOKEN}` } : {}),
    },
    body: JSON.stringify({ to: email, from: EMAIL_FROM, subject, text, html }),
  });
  if (!response.ok) throw Object.assign(new Error("Email delivery failed."), { status: 502 });
  return { delivered: true };
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
  if (!authorization.startsWith("Bearer ")) return null;
  const tokenHash = hashToken(authorization.slice(7));
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
  const activeCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return {
    totalLogins: store.activity.filter((item) => item.action === "login").length,
    activeUsers: store.users.filter((user) => user.lastActiveAt && Date.parse(user.lastActiveAt) >= activeCutoff).length,
    configurationsSaved: store.activity.filter((item) => item.action === "save_config").length,
    configurationsLoaded: store.activity.filter((item) => item.action === "load_config").length,
    pdfExports: store.activity.filter((item) => item.action === "pdf_export").length,
    lastActivityAt: store.activity[0]?.timestamp || null,
  };
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
      const existing = store.registrationRequests.find((item) => item.email === validation.email && item.status === "pending");
      if (!existing && status === "pending") {
        store.registrationRequests.unshift({
          id: crypto.randomUUID(), email: validation.email, company, status: "pending",
          tool: String(body.tool || "GPU_RA_and_NVAIE_TCO_Analysis").slice(0, 120), requestedAt: new Date().toISOString(),
        });
      }
      addActivity(store, validation.email, "request_access", { company, status });
      if (status === "approved") {
        const magicUrl = createMagicLinkRecord(store, user, "registration");
        delivery = await deliverAccessEmail({ email: user.email, company: user.company, magicUrl, expiresMinutes: MAGIC_LINK_MINUTES });
      }
    });
    return sendJson(req, res, 202, {
      message: "If the address is eligible, the request is pending approval or an access link has been sent.",
      ...(ALLOW_DEV_AUTH && delivery?.devMagicLink ? { devMagicLink: delivery.devMagicLink } : {}),
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
    await mutateStore(async (store) => {
      const link = store.magicLinks.find((item) => item.tokenHash === tokenHash && !item.usedAt && Date.parse(item.expiresAt) > Date.now());
      const user = link && userForEmail(store, link.email);
      if (!link || !user || user.status !== "approved") throw Object.assign(new Error("This access link is invalid or expired."), { status: 401 });
      link.usedAt = new Date().toISOString();
      exchangeCode = randomToken(24);
      store.exchangeCodes.push({
        id: crypto.randomUUID(), email: user.email, codeHash: hashToken(exchangeCode),
        createdAt: new Date().toISOString(), expiresAt: expiresAt(5 * 60 * 1000), usedAt: null,
      });
      addActivity(store, user.email, "consume_magic_link");
    });
    const redirect = new URL(APP_REDIRECT_URI);
    redirect.searchParams.set("access_code", exchangeCode);
    return sendRedirect(req, res, redirect.toString());
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
      const rawSessionToken = randomToken();
      const session = {
        id: crypto.randomUUID(), email: user.email, tokenHash: hashToken(rawSessionToken),
        createdAt: new Date().toISOString(), expiresAt: expiresAt(SESSION_HOURS * 60 * 60 * 1000), revokedAt: null,
      };
      store.sessions.push(session);
      user.lastActiveAt = new Date().toISOString();
      user.loginCount = Number(user.loginCount || 0) + 1;
      addActivity(store, user.email, "login", { sessionId: session.id });
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

  if (method === "GET" && pathname === "/me") {
    return sendJson(req, res, 200, { email: user.email, company: user.company, role: user.role, isAdmin: user.isAdmin });
  }

  if (method === "POST" && pathname === "/auth/logout") {
    await mutateStore(async (nextStore) => {
      const session = nextStore.sessions.find((item) => item.id === user.sessionId);
      if (session) session.revokedAt = new Date().toISOString();
      addActivity(nextStore, user.email, "logout");
    });
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
