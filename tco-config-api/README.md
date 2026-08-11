# TCO Config API

This API provides company-email access requests, administrator approval, one-time email access links, saved calculator configurations, and activity reporting.

## Security model

- Personal email domains are rejected; an optional `REQUIRED_EMAIL_DOMAIN` can restrict access further.
- A new user remains pending until an administrator approves the request.
- Any approved user may invite a customer company email, but the invitation remains pending until an administrator uses the one-time approval link emailed to them.
- Approval emails a random, one-time link to the approved address. Only a SHA-256 token hash is stored.
- The email link expires after 30 minutes by default and can be used once.
- In the VM deployment, the one-time link creates a 12-hour `HttpOnly` session cookie. Only the session hash is stored by the API. The bearer-token exchange remains available for non-cookie clients.
- Email credentials and administrator data stay server-side. Do not place them in the HTML or `access_approval_config.js`.
- CORS accepts only the exact origins in `ALLOWED_ORIGINS`.
- Production cookie sessions are `HttpOnly`, `Secure`, `SameSite=Lax`, and can be enforced by nginx before calculator files are served.
- The admin dashboard reports invitations, pending approvals, approved users, 7/30-day active users, returning users, total logins, saved configurations, and per-user login frequency.

This flow does not use Starfleet, OIDC, a username, or a password. Users request approval and open the calculator from an emailed one-time invite link.

## Deployment

1. Deploy this folder to an NVIDIA-approved Node.js service with persistent encrypted storage mounted at `DATA_DIR`.
2. Put the values from `env.sample` in the deployment secret/environment manager.
3. Set `ADMIN_EMAILS` to the administrator company email(s).
4. Connect `EMAIL_DELIVERY_WEBHOOK_URL` to the approved internal email service. It receives JSON with `to`, `from`, `subject`, `text`, and `html`.
5. Set `PUBLIC_API_BASE_URL` to this deployed API URL and `APP_REDIRECT_URI` to the exact calculator URL.
6. Add the hosted calculator origin to `ALLOWED_ORIGINS`.
7. Set the same API URL as `approvalApiUrl` in `access_approval_config.js`, then set `enabled: true`.

## `autotco` VM layout

Use the files in `deploy/` for a same-origin production installation:

```text
/opt/autotco/api/          server.js and package.json
/opt/autotco/public/       public/access.html
/opt/autotco/calculator/   calculator HTML and supporting files
/var/lib/autotco/          encrypted persistent API data
/etc/autotco/api.env       root-readable production secrets
```

1. The deployment is configured for `autotco.nvidia.com` (`10.64.146.94` on the private network). Confirm the external VIP/load balancer and certificate paths before deployment.
2. Install Node.js 20+, nginx, and a trusted TLS certificate on the VM.
3. Create the locked service account and directories:

```bash
sudo useradd --system --home /opt/autotco --shell /usr/sbin/nologin autotco
sudo install -d -o autotco -g autotco -m 0750 /opt/autotco/api /opt/autotco/public /opt/autotco/calculator
sudo install -d -o autotco -g autotco -m 0700 /var/lib/autotco
sudo install -d -o root -g autotco -m 0750 /etc/autotco
```

4. Copy the API, `public/access.html`, calculator files, and `deploy/access_approval_config.production.js` (renamed to `access_approval_config.js`) into those directories.
5. Put production settings in `/etc/autotco/api.env` with mode `0640`, owned by `root:autotco`.
6. Install `deploy/autotco-api.service` in `/etc/systemd/system/` and the nginx file in `/etc/nginx/conf.d/`.
7. Start the API and reload nginx:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now autotco-api
sudo nginx -t
sudo systemctl reload nginx
```

8. Verify `/api/health`, request access with a partner company email, approve from the administrator email, redeem the partner's one-time link, and confirm the admin dashboard records the login.

The production nginx configuration protects `/calculator/` with an API session check. The public GitHub Pages copy must not be treated as access-controlled; remove or replace that copy before confidential calculator data is added.

## Databricks cloud pricing

All calculator HTML files load their default cloud GPU prices from the authenticated `GET /api/cloud-prices` endpoint. The API queries this authoritative table and caches the normalized per-GPU-hour averages for 60 minutes by default:

```text
Host:  https://nvidia-edsp-fdp-prd.cloud.databricks.com
Table: edsp_fdp_nala_fpa_prod.gpu_cloud_model.unified_dataset_automotive
```

Set `DATABRICKS_WAREHOUSE_ID` and `DATABRICKS_TOKEN` in `/etc/autotco/api.env`. The token must belong to a service principal with only the permissions needed to use the SQL warehouse and read this table. Never put it in calculator HTML or client JavaScript.

The API detects common SKU, per-GPU-hour price, and provider column names. If the table uses different names, set `DATABRICKS_SKU_COLUMN`, `DATABRICKS_PRICE_COLUMN`, and `DATABRICKS_PROVIDER_COLUMN`. The browser retains its embedded price snapshot only as an explicitly reported offline fallback if the authenticated Databricks-backed endpoint is unavailable.

## Microsoft 365 email delivery

The API can use either the existing email webhook or Microsoft Graph. For Graph, IT must provide a confidential Entra application with `Mail.Send` application permission, administrator consent, a sender mailbox restricted by an application access policy, and the four `MS_GRAPH_*` environment values. Keep the client secret only in `/etc/autotco/api.env` or the approved secret manager.

Never publish `EMAIL_DELIVERY_BEARER_TOKEN` or the contents of `DATA_DIR`.

## Local test

Use the bundled development mode only on a local machine:

```bash
ALLOW_DEV_AUTH=true \
ADMIN_EMAILS=deanh@nvidia.com \
ALLOWED_ORIGINS=http://127.0.0.1:8767 \
PUBLIC_API_BASE_URL=http://127.0.0.1:8787 \
APP_REDIRECT_URI=http://127.0.0.1:8767/GPU_RA_and_NVAIE_TCO_Analysis.html \
node server.js
```

When `ALLOW_DEV_AUTH=true` and no email webhook is configured, registration and login-link responses include `devMagicLink`, and invitation responses include `devApprovalLink`. Production responses never expose either link.

## Endpoints

- `GET /health`
- `POST /registration-requests`
- `POST /invitation-requests` (approved users only)
- `GET /admin/approve-invite?token=...` (one-time administrator email approval)
- `POST /auth/request-link`
- `GET /auth/magic?token=...`
- `POST /auth/exchange`
- `POST /auth/logout`
- `GET /auth/check` (nginx session gate)
- `GET /me`
- `GET /cloud-prices` (approved users; Databricks-backed and cached)
- `GET /configs`
- `POST /configs`
- `DELETE /configs/:id`
- `GET /admin/dashboard`
- `POST /admin/registration-requests/:id/approve`
- `POST /admin/registration-requests/:id/deny`
