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
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS || "deanh@nvidia.com").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean));
const REQUIRED_EMAIL_DOMAIN = (process.env.REQUIRED_EMAIL_DOMAIN || "nvidia.com").toLowerCase();

async function readStore() {
  try {
    return JSON.parse(await fs.readFile(STORE_FILE, "utf8"));
  } catch {
    return { configs: [], activity: [] };
  }
}

async function writeStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE_FILE, JSON.stringify(store, null, 2));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function devUserFromHeaders(req) {
  const email = String(req.headers["x-dev-user-email"] || "").trim().toLowerCase();
  if (!email) return null;
  return { email, isAdmin: ADMIN_EMAILS.has(email) };
}

async function userFromRequest(req) {
  if (ALLOW_DEV_AUTH) {
    const devUser = devUserFromHeaders(req);
    if (devUser) return devUser;
  }

  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) {
    return null;
  }

  // Production Starfleet/OIDC validation should verify the bearer token here
  // using the Starfleet issuer/JWKS or NVIDIA-approved middleware.
  // Until that is added, do not run with ALLOW_DEV_AUTH=false in production.
  return null;
}

function requireNvidiaUser(user) {
  return Boolean(user?.email && user.email.endsWith(`@${REQUIRED_EMAIL_DOMAIN}`));
}

function addActivity(store, user, action, detail = {}) {
  store.activity.unshift({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    userEmail: user.email,
    action,
    detail,
  });
  store.activity = store.activity.slice(0, 2000);
}

function routeKey(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return { method: req.method, pathname: url.pathname, searchParams: url.searchParams };
}

async function handle(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  const { method, pathname, searchParams } = routeKey(req);

  if (pathname === "/health") {
    return sendJson(res, 200, { ok: true, service: "tco-config-api" });
  }

  const user = await userFromRequest(req);
  if (!requireNvidiaUser(user)) {
    return sendJson(res, 401, { error: "Authentication required" });
  }

  const store = await readStore();

  if (method === "GET" && pathname === "/me") {
    return sendJson(res, 200, { email: user.email, isAdmin: user.isAdmin });
  }

  if (method === "GET" && pathname === "/configs") {
    return sendJson(res, 200, {
      configs: store.configs.filter((config) => config.ownerEmail === user.email),
    });
  }

  if (method === "POST" && pathname === "/configs") {
    const body = await readJson(req);
    const now = new Date().toISOString();
    const id = body.id || crypto.randomUUID();
    const nextConfig = {
      id,
      ownerEmail: user.email,
      name: String(body.name || "Untitled configuration").slice(0, 120),
      calculator: String(body.calculator || "GPU_RA_and_NVAIE_TCO_Analysis"),
      payload: body.payload || {},
      createdAt: body.id ? body.createdAt || now : now,
      updatedAt: now,
    };
    store.configs = store.configs.filter((config) => !(config.id === id && config.ownerEmail === user.email));
    store.configs.unshift(nextConfig);
    addActivity(store, user, "save_config", { id, name: nextConfig.name, calculator: nextConfig.calculator });
    await writeStore(store);
    return sendJson(res, 200, { config: nextConfig });
  }

  if (method === "DELETE" && pathname.startsWith("/configs/")) {
    const id = pathname.split("/").pop();
    const before = store.configs.length;
    store.configs = store.configs.filter((config) => !(config.id === id && config.ownerEmail === user.email));
    addActivity(store, user, "delete_config", { id });
    await writeStore(store);
    return sendJson(res, 200, { deleted: before !== store.configs.length });
  }

  if (method === "GET" && pathname === "/admin/activity") {
    if (!user.isAdmin) return sendJson(res, 403, { error: "Admin access required" });
    return sendJson(res, 200, { activity: store.activity });
  }

  if (method === "GET" && pathname === "/admin/configs") {
    if (!user.isAdmin) return sendJson(res, 403, { error: "Admin access required" });
    const ownerEmail = searchParams.get("ownerEmail");
    return sendJson(res, 200, {
      configs: ownerEmail ? store.configs.filter((config) => config.ownerEmail === ownerEmail.toLowerCase()) : store.configs,
    });
  }

  return sendJson(res, 404, { error: "Not found" });
}

http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    sendJson(res, 500, { error: "Server error", detail: error.message });
  });
}).listen(PORT, () => {
  console.log(`TCO config API listening on ${PORT}`);
});
