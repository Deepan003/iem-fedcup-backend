# IEM FED Cup — Auction Backend

Node 20 · Express · Socket.IO · MongoDB (Mongoose) · Cloudflare R2 · Google Sheets/Drive

This server runs the live auction. It is the single source of truth for bids, timers, budgets and squads, and it pushes live updates to the studio, captains and admin over WebSockets.

Only **four values** live in environment variables. Everything else (Google key, R2 keys, sheet link, auction rules, captain passwords, portal code) is entered in the **admin panel** and stored **encrypted (AES-256-GCM)** in MongoDB.

| Variable | What it is |
|---|---|
| `MONGODB_URI` | MongoDB Atlas connection string |
| `MASTER_KEY` | Long random secret that encrypts stored credentials and signs logins. **Never change it after setup.** |
| `ADMIN_PASSWORD` | Used for the first admin login only. Change the password in the panel afterwards. |
| `CORS_ORIGIN` | Frontend URL(s), comma-separated, e.g. `https://fedcup.pages.dev` |

---

## 1. MongoDB Atlas (free, 512 MB)

1. Go to <https://cloud.mongodb.com> and sign up.
2. **Create a cluster**: choose **M0 Free**, provider **AWS**, region **Mumbai (ap-south-1)**, and any name.
3. **Database Access → Add New Database User**: choose a username, auto-generate a password and save it, and give it the role *Read and write to any database*.
4. **Network Access → Add IP Address → Allow access from anywhere** (`0.0.0.0/0`). Hosting providers change IP addresses, so this is required. The database is still protected by the user's password.
5. **Connect → Drivers** and copy the connection string. Replace `<password>` and add the database name `fedcup` after `.net/`:
   ```
   mongodb+srv://fedcup:YOURPASSWORD@cluster0.abcde.mongodb.net/fedcup?retryWrites=true&w=majority
   ```
   This is your `MONGODB_URI`.

## 2. Cloudflare R2 (free 10 GB, no bandwidth charges)

1. Sign in at <https://dash.cloudflare.com> and open **R2 Object Storage**. Cloudflare asks for a card to activate R2 even on the free tier; you are not charged under 10 GB.
2. **Create bucket**, named for example `fedcup-media`, with location *Automatic*.
3. Make the bucket publicly readable (only for images):
   - **Recommended for the live event:** Bucket → **Settings → Custom Domains → Connect Domain**, e.g. `media.yourdomain.com` (the domain must be on Cloudflare). This is cached by Cloudflare's CDN and has no rate limit.
   - **For testing:** Bucket → **Settings → Public Development URL (r2.dev) → Enable**. Cloudflare rate-limits r2.dev and says it is not for production, so switch to a custom domain before the auction.
   - Copy the public URL, for example `https://media.yourdomain.com` or `https://pub-xxxx.r2.dev`.
4. On the R2 overview page, copy your **Account ID**.
5. Go to **R2 → Manage API Tokens → Create API Token**:
   - Permission: **Object Read & Write**
   - Specify bucket: `fedcup-media` only
   - Create the token and copy the **Access Key ID** and **Secret Access Key**. The secret is shown only once.
6. In the website, open **Admin → Integrations → Cloudflare R2** and paste the Account ID, Access Key ID, Secret, bucket name and public URL, then click Save. The server uploads and deletes a test file before saving, so wrong keys are caught immediately.

> Until R2 is set up, images are stored in MongoDB and served by this API, so everything still works. Photos are compressed to about 100 KB each, so 150 players use about 15 MB.

## 3. Google Sheets + Drive (read the player sheet and photos)

1. Go to <https://console.cloud.google.com> and create a project, e.g. `fedcup`.
2. **APIs & Services → Library**: enable **Google Sheets API** and **Google Drive API**.
3. **IAM & Admin → Service Accounts → Create service account**, named e.g. `fedcup-reader`. It needs no roles, so click Done.
4. Open the service account and go to **Keys → Add key → Create new key → JSON**. A `.json` file downloads.
5. In the website, open **Admin → Integrations → Google**, paste the whole JSON file content and click Save. Note the email it shows, e.g. `fedcup-reader@fedcup.iam.gserviceaccount.com`.
6. **Share with that email (Viewer):**
   - the auction Google Sheet
   - the Google Form's photo-upload folder in Drive (usually `<Form name> (File responses)/…`)
7. In **Admin → Integrations → Sheet**, paste the sheet link and click **Test**. You should see the sheet's tabs.
8. In **Admin → Import**, click **Preview**, check the new, updated and skipped rows, then click **Import**.
9. Click **Sync photos**. The server downloads each photo, auto-rotates and crops it, converts it to WebP and uploads it. Players whose photo failed (for example iPhone HEIC files or private files) are listed so you can upload their photo manually.

The importer understands the current sheet layout (NAME, POSITION, TIER, PHOTO, YEAR). It skips section rows such as "DEFENDER" and keeps any extra columns. Re-importing later **never overwrites auction results**.

## 4. Try it locally — demo mode (no setup needed)

```bash
npm install
npm run demo -- --fresh --bots
```
This starts a local database and the API, then seeds **6 teams** (logos, captains, one retained player each) and **90 demo players** with generated photos and tiers. It prints the admin password and every captain password. With `--bots`, computer captains bid for every team except the first, so you can run a realistic auction alone. Then start the frontend (`cd ../frontend && npm run dev`) and open <http://localhost:5173>.

- `npm run demo` keeps the demo data between runs (stored in `.demo-data/`).
- `npm run demo -- --fresh` wipes it and seeds again.
- `npm run smoke` runs a full automated end-to-end test of the auction (21 checks).

## 5. Run locally against your own database

```bash
cp .env.example .env      # fill in the values
npm install
npm run dev               # http://localhost:4000/api/health
npm test                  # auction engine tests
```

## 6. Deploy (backend)

The auction needs **one always-on instance**, because live WebSockets and timers run in memory. **Do not use a plan that sleeps** (Render's free tier sleeps after 15 minutes idle and takes about a minute to wake). Run only one instance; do not scale horizontally.

**Render (simple):** New → **Web Service** → connect this repo.
- Runtime: Node · Build command: `npm ci` · Start command: `npm start`
- Region: **Singapore** (closest to India) · Instance type: **Starter** or higher during the auction period
- Environment: `MONGODB_URI`, `MASTER_KEY`, `ADMIN_PASSWORD`, `CORS_ORIGIN`, `NODE_ENV=production`
- Health check path: `/api/health`

Railway and Fly.io work the same way (Node 20, `npm start`, same env vars, always-on).

After the first deploy:
1. Open the website's `/admin` and log in with `ADMIN_PASSWORD`, then **change the password** immediately.
2. Add Google, R2 and the sheet in Integrations, then import players and sync photos.
3. Set the auction rules, add teams (logo, captain, retained players), and generate captain passwords.
4. Do a full **rehearsal**, then **Admin → Reset auction** before the real one.

## API overview

| Area | Endpoints |
|---|---|
| Health | `GET /api/health` |
| Auth | `POST /api/auth/admin` · `POST /api/auth/captain` |
| Public | `GET /api/config` · `GET /api/state` · `GET /api/teams` · `GET /api/players` · `GET /api/players/search?q=` · `GET /api/media/*` |
| Captain | `GET/PUT /api/captain/plan` (formation, lineup, watchlist) |
| Admin | settings (`/settings/:section` for auction, captainView, studio, portal), integrations (google, r2, sheet), import (preview, commit, photos), teams (CRUD, logo, captain photo, password, retained), players (CRUD, photo, bulk, shuffle), auction (reset, bids, logs, export.csv), password |

**Socket.IO** (pass `auth: { token }` for captain or admin):
- server → client: `state` (full snapshot), `bid` (small delta with `v`), `viewers`, `job` (photo sync progress)
- client → server: `sync` (clock offset), `state:get`, `bid` `{lotSeq, amount}` (captain), `admin` `{action, args}` (admin)

Admin actions: `start, end, setMode, loadLot, openBidding, pause, resume, extend, closeBidding, reopenBidding, confirmSale, markUnsold, undoLastBid, withdrawLot, manualSale, proxyBid, undoLastSale, startUnsoldRound` (and `hammerNow` when confirmation is turned off).

## How bidding stays fair
- **The auctioneer confirms every sale.** When the timer ends, bidding closes and the lot waits for the auctioneer (`awaiting`). Nothing is sold until **Confirm SOLD** is clicked. The auctioneer can instead **Reopen bidding**, **Undo last bid**, or **Mark UNSOLD**. (Setting: `requireConfirm`, on by default.)
- Mistakes can be reversed: **Undo last bid** during a lot, **Undo last sale** (repeatable, newest first), **Withdraw lot**, and **Reset auction** for after a rehearsal.
- The server processes bids one at a time. A captain's bid must carry the **exact next amount** shown on their screen. If two captains press at the same moment, the first one wins and the second gets `STALE_AMOUNT` and the new price. Two teams can never hold the same bid.
- Every client syncs its clock with the server, so all screens show the same countdown. A bid resets the timer, and a small grace window (default 400 ms) covers network delay.
- Budget guard: a team can never bid so high that it cannot complete its minimum squad, and it cannot exceed a position's maximum (e.g. 2 GKs).
- Every change is written to MongoDB. After a crash or restart the auction comes back **paused** on the same lot with the same price and remaining time.
- Every bid, rejection and admin action is stored in an audit log.
