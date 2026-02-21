# ALPHA-TECH X — Send Console

## Environment

Copy `.env.local.example` to `.env.local` and set:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (preferred)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (optional fallback if publishable key is not set)
- `SUPABASE_SERVICE_ROLE_KEY` (server-only; required for user_id login endpoint)
- `ALPHA_TECH_X_ADMIN_EMAILS` (comma-separated allowlist)
- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REDIRECT_URI` (for local dev callback URL)
- `GMAIL_REFRESH_TOKEN`
- `GMAIL_SENDER_EMAIL`

Set the same environment variables in Vercel Project Settings, and keep
`SUPABASE_SERVICE_ROLE_KEY` as a server-only secret (never expose it to client code).
Google OAuth credentials/tokens must also be stored as server-side secrets.

## Database Migrations

Run the SQL migrations in Supabase:

- `supabase/migrations/20260221_create_contacts.sql`
- `supabase/migrations/20260222_create_profiles.sql`
- `supabase/migrations/20260223_create_send_logs.sql`

`20260222_create_profiles.sql` creates:

- `public.profiles` (`auth_user_id`, `user_id`, `role`, timestamps)
- RLS self-select policy for authenticated users
- Trigger for `updated_at`
- Trigger on `auth.users` insert to auto-create a profile:
  - default `user_id` is email prefix (or fallback generated value)
  - default `role` is `user`

## Creating Users

1. In Supabase Dashboard -> Authentication -> Users, create user with:
   - real email
   - password
2. Update profile row as needed (SQL editor):

```sql
update public.profiles
set user_id = 'your_user_id', role = 'admin'
where auth_user_id = 'USER_UUID_HERE';
```

Use `role='admin'` for admin users. You can also keep email allowlist override via
`ALPHA_TECH_X_ADMIN_EMAILS`.

## Run

```bash
npm install
npm run dev
```

## Email Notes

- Email sending is handled by `POST /api/send-email`.
- PDFs are not stored on the server; the browser extracts PDF bytes from ZIP and sends
  base64 payload for immediate send.
- The route requires an authenticated admin user.
- Email provider is Gmail API (OAuth2 refresh token).

## Gmail API Setup

1. Create a Google Cloud project and enable Gmail API.
2. Create an OAuth client (Web application) with redirect URI:
   - `http://localhost:3000/api/google/oauth/callback`
3. Set `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and `GMAIL_REDIRECT_URI`.
4. Open `/api/google/oauth/start` locally and complete consent.
5. Copy the `refreshToken` returned by `/api/google/oauth/callback` into `GMAIL_REFRESH_TOKEN`.
6. Set `GMAIL_SENDER_EMAIL` to the Gmail account used in OAuth and restart app.

## Routes

- `/login` public login page (User ID or Email + Password)
- `/auth/callback` handles Supabase auth callbacks (including password reset links)
- `/` admin-only Upload & Send console
- `/contacts` admin-only contacts management
- `/user` authenticated user portal placeholder
- `/access-denied` admin-required page for non-admin authenticated users
- `/api/send-email` authenticated admin Gmail send route
- `/api/google/oauth/start` local OAuth start route for refresh token generation
- `/api/google/oauth/callback` local OAuth callback route for refresh token generation
