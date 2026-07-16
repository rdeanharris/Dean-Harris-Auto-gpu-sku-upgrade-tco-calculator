# TCO Config API

This is the backend API that should become `apiBaseUrl` after it is deployed.

It is separate from Starfleet:

- Starfleet handles login / identity.
- This API stores TCO calculator saved configurations and admin activity logs.

## Required production work

Before using this in production, add NVIDIA-approved Starfleet/OIDC token validation in `userFromRequest()`.

The current server intentionally refuses bearer-token auth until that validation is added. Local development can be tested with:

```bash
ALLOW_DEV_AUTH=true ADMIN_EMAILS=deanh@nvidia.com node server.js
```

Then call the API with:

```bash
curl -H "x-dev-user-email: deanh@nvidia.com" http://localhost:8787/me
```

## Endpoints

- `GET /health`
- `GET /me`
- `GET /configs`
- `POST /configs`
- `DELETE /configs/:id`
- `GET /admin/configs`
- `GET /admin/activity`

## App config

Once this API is deployed, set:

```js
apiBaseUrl: "https://<deployed-tco-api-host>"
```

in `starfleet_auth_config.js`.

Also set `redirectUri` to the exact hosted calculator URL registered in Starfleet.
