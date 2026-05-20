# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

QuickRebas is an English audio platform tied to physical EFL/ESL workbooks. Students buy a workbook, scratch a code panel, activate the code on this site, and get 6 months of access to audio tracks. Teachers use an admin panel to generate codes, manage students, and assign audio URLs to each track.

## Commands

There is no build step. All HTML/CSS/JS is served as-is. Deploy to Netlify by pushing — the `netlify.toml` configures the function and redirects automatically.

**Local development with the Netlify function:**
```bash
npm install -g netlify-cli
netlify dev          # serves site on localhost:8888 with the function available at /api
```

**Required environment variables** (set in Netlify dashboard or a `.env` file for `netlify dev`):
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_KEY` — Supabase service role or anon key
- `ADMIN_PASS` — Admin password (defaults to `quickrebas2025` if unset)

There are no tests or linters configured.

## Architecture

### File layout
```
index.html          ← Public landing page + code activation widget
activate.html       ← 3-step activation wizard (code → account → success)
signin.html         ← Student login
student.html        ← Student dashboard with audio player
admin.html          ← Teacher admin panel (password-protected)
netlify/functions/
  api.js            ← Single serverless function; all backend logic lives here
netlify.toml        ← Redirects /api/* → /.netlify/functions/api
package.json        ← Only lists @netlify/blobs (unused in practice)
```

### No framework, no bundler
Every page is a self-contained HTML file with inline `<style>` and `<script>`. There are no imports, no transpilation, and no shared CSS/JS files between pages.

### API design
`netlify/functions/api.js` is a single handler routed by `?action=`. It talks to Supabase over raw HTTPS using the Node `https` module (no SDK). All responses return HTTP 200 with `{ status: 'ok' | 'error', ... }` — errors are never signalled via HTTP status codes to the client.

| action | method | auth | description |
|---|---|---|---|
| `ping` | GET | none | Connectivity and DB smoke test |
| `generate` | POST | adminPass in body | Create access codes; saves to `codes` table |
| `verify` | GET | none | Check if a code is unused |
| `activate` | POST | none | Link code to student; writes `codes` + `students` |
| `signin` | POST | none | Authenticate student by email+password |
| `listCodes` | GET | adminPass in query | Fetch all codes |
| `listStudents` | GET | adminPass in query | Fetch all students |
| `revoke` | GET | adminPass in query | Set code status to `revoked` |
| `saveAudio` | POST | adminPass in body | Upsert audio URL map into `settings` table |
| `getAudio` | GET | none | Fetch audio URL map |

### Database schema (Supabase)
Three tables accessed via Supabase REST (`/rest/v1/`):
- **`codes`**: `code`, `book`, `status` (`unused`/`active`/`revoked`), `created_at`, `student_name`, `email`, `activated_at`, `expires_at`
- **`students`**: `name`, `email`, `password` (plaintext), `book`, `level`, `code`, `activated_at`, `expires_at`
- **`settings`**: `key`, `value` — one row with `key='audio_urls'` holds a JSON blob of all track URLs

### Audio URL storage
Audio URLs are stored as a single flat JSON object in the `settings` table, keyed by `{bookLevel}-{trackId}`, e.g.:
```json
{ "a0-1.1": "https://youtube.com/...", "a0-1.2": "https://..." }
```
The admin "Audio files" panel reads, edits, and saves this whole object at once.

### Audio playback (student.html)
- **YouTube URLs** (containing `youtube.com` or `youtu.be`): played via a floating iframe embed in the bottom-right corner
- **Direct URLs** (MP3 etc): played via a hidden `<audio id="aud">` element with a custom progress bar

### Track data is hardcoded in two places
`admin.html` has a `TRACKS` object and `student.html` has a `BOOKS` object. Both define the same 5 books (A0–B2) and their tracks, but in slightly different shapes. **If track IDs or names change, both files must be updated.** Track IDs follow the pattern `{unit}.{track}` (e.g., `1.1`, `2.3`).

### Auth model
- **Admin**: password compared against `ADMIN_PASS` env var in the function. On the client, the password is stored in `sessionStorage` and resent with every admin request.
- **Students**: email + plaintext password compared in the function. On success, the session is stored in `localStorage` as `qr_session` (JSON with `name`, `email`, `book`, `level`, `code`, `expiry`, `active`). Expiry is checked client-side on every page load.

### localStorage keys used across pages
| key | set by | read by |
|---|---|---|
| `qr_session` | activate.html, signin.html | student.html, signin.html |
| `qr_pending_code` | index.html, activate.html | activate.html |
| `qr_pending_book` / `qr_pending_level` | activate.html | activate.html |
| `qr_redirect` | student.html | student.html (post-login redirect) |
| `qr_saved_email` | signin.html | signin.html |

### Design system
CSS custom properties defined on `:root` in each file:
- `--gold: #E8A04C` (primary accent)
- `--ink: #0F1218` (dark background)
- `--ink2: #161C26` (sidebar background, admin/student only)
- `--white: #fff`
- `--border: rgba(255,255,255,0.08)`

Fonts: **Montserrat** (body/UI), **Fraunces** (headings). Both loaded from Google Fonts.

### Code format
Access codes follow the pattern `QR-{BOOK}-{4chars}-{4chars}` using uppercase alphanumerics (excluding ambiguous characters `I`, `O`, `1`, `0`). Example: `QR-A0-7X4K-9M2P`.
