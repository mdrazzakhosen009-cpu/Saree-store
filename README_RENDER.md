# Saree Store — Fixed Render/Turso Build

## What was fixed
- Turso is required in production; the app no longer silently falls back to `local.db` on Render.
- Database initialization runs before the server starts accepting requests.
- Sessions are stored in Turso instead of Express MemoryStore.
- Product add, edit, delete and featured status are persistent in Turso.
- Store settings and admin password are persistent in Turso.
- Product/logo image uploads are stored as data URLs in Turso so Render restarts do not remove them.
- Added missing `/admin/password` GET/POST routes.
- Added missing product edit page and update route.
- Added error handling and basic validation.
- Added default SVG logo/product placeholders.
- Kept the existing EJS storefront structure and main features.

## Render Environment Variables
Set these in Render → Service → Environment:

- `NODE_ENV` = `production`
- `TURSO_DATABASE_URL` = your Turso database URL
- `TURSO_AUTH_TOKEN` = your Turso auth token
- `SESSION_SECRET` = a long random secret
- `ADMIN_SECRET_FALLBACK_PASSWORD` = a strong first-login password

Do not put the real token/password in this repository.

## Build/Start
Build Command:
`npm install`

Start Command:
`npm start`

## Important
After the first successful deployment, log in with the admin credentials and immediately change the password from **Settings & Logo** or **Change Password**.

Existing old image paths such as `/uploads/filename.jpg` cannot magically restore files that were only stored on an old Render filesystem. Re-upload those product/logo images once; the new version stores uploaded images in Turso.


## Shopping Agent
The storefront includes a database-backed Saree Shopping Agent at `/api/agent/chat`. It searches the live Turso product catalog, gives delivery/order guidance, recommends products, and tracks order IDs. No external AI API key is required.
