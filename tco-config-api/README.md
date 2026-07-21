# TCO Config API

This API provides company-email access requests, administrator approval, one-time email access links, saved calculator configurations, and activity reporting.

## Security model

- Personal email domains are rejected; an optional `REQUIRED_EMAIL_DOMAIN` can restrict access further.
- A new user remains pending until an administrator approves the request.
- Approval emails a random, one-time link to the approved address. Only a SHA-256 token hash is stored.
- The email link expires after 30 minutes by default and can be used once.
- The browser exchanges the one-time code for a 12-hour session. Only the session hash is stored by the API.
- Email credentials and administrator data stay server-side. Do not place them in the HTML or `access_approval_config.js`.
- CORS accepts only the exact origins in `ALLOWED_ORIGINS`.

This flow does not use Starfleet, OIDC, a username, or a password. Users request approval and open the calculator from an emailed one-time invite link.

## Deployment

1. Deploy this folder to an NVIDIA-approved Node.js service with persistent encrypted storage mounted at `DATA_DIR`.
2. Put the values from `env.sample` in the deployment secret/environment manager.
3. Set `ADMIN_EMAILS` to the administrator company email(s).
4. Connect `EMAIL_DELIVERY_WEBHOOK_URL` to the approved internal email service. It receives JSON with `to`, `from`, `subject`, `text`, and `html`.
5. Set `PUBLIC_API_BASE_URL` to this deployed API URL and `APP_REDIRECT_URI` to the exact calculator URL.
6. Add the hosted calculator origin to `ALLOWED_ORIGINS`.
7. Set the same API URL as `approvalApiUrl` in `access_approval_config.js`, then set `enabled: true`.

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

When `ALLOW_DEV_AUTH=true` and no email webhook is configured, registration and login-link responses include `devMagicLink`. Production responses never expose that link.

## Endpoints

- `GET /health`
- `POST /registration-requests`
- `POST /auth/request-link`
- `GET /auth/magic?token=...`
- `POST /auth/exchange`
- `POST /auth/logout`
- `GET /me`
- `GET /configs`
- `POST /configs`
- `DELETE /configs/:id`
- `GET /admin/dashboard`
- `POST /admin/registration-requests/:id/approve`
- `POST /admin/registration-requests/:id/deny`
