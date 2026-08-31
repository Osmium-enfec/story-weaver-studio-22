# Move media storage to DigitalOcean Spaces

Goal: stop filling cloud database storage with daily-generated videos/audio/images. Move all media to a DigitalOcean Spaces bucket you provide, and migrate the existing ~6.2 GB so old episodes keep working.

## Good news

The app already has a Spaces/S3 backend wired in (`src/lib/object-storage.ts` — `useSpaces()` with `SPACES_BUCKET/KEY/SECRET/ENDPOINT`). Server-side reads, writes, signed URLs, and the render-Mac public asset endpoint all switch over automatically once the env vars are set. The remaining work is the browser direct-upload path and the one-time migration.

## Steps

1. **Add Spaces credentials**
   - You create a Spaces bucket + access keys in your DigitalOcean account (same steps as the existing `deploy/README.md` Phase 2).
   - Store `SPACES_ENDPOINT`, `SPACES_REGION`, `SPACES_BUCKET`, `SPACES_KEY`, `SPACES_SECRET` as project secrets via the secrets tool (you paste values, I store them — never in code).

2. **Browser direct-upload path for Spaces** (the main gap)
   - Large video uploads currently bypass the server via signed cloud-storage URLs; add the equivalent for Spaces: a server route that returns an S3 presigned PUT URL, browser uploads straight to Spaces.
   - Files: `src/lib/persist-client-asset.ts`, `src/routes/api/persist-asset.ts` (add presign branch when `useSpaces()`), plus CORS note: the Spaces bucket needs a CORS rule allowing PUT from the app origin — I'll give you the exact rule to paste in the DO dashboard.

3. **Verify the flip**
   - With `SPACES_*` set, `useSpaces()` already wins over cloud storage in `putAsset`, `readAsset`, `signedAssetUrl`, `assetExists`, `materializeAssetToFile`.
   - Smoke test: upload a video clip + image in the preview, confirm objects land in the Spaces bucket and playback/preview works.

4. **Migrate existing ~6.2 GB**
   - Write `scripts/migrate-cloud-to-spaces.mjs`: lists every object in the cloud `project-assets` bucket (project-assets/ and app-assets/ prefixes), downloads each, uploads to Spaces under the same key layout, with a `--dry-run` mode and per-file verification (size match).
   - Run it from the sandbox; resume-safe (skips objects already present with matching size).
   - After migration, episodes, scene audio, thumbnails, and the HD render bundles keep working unchanged because the app keeps using `/api/assets/...` URLs — only the backend behind them changes.

5. **Keep / cleanup decision**
   - After you confirm old episodes play from Spaces, I can optionally purge the old bucket contents to free the 6.2 GB (separate confirmation before deleting anything).

## Technical notes

- No database schema changes; `image_assets.public_url` and scene asset paths stay `/api/assets/...` and are resolved by the storage layer.
- The HD render Mac pulls via `/api/public/assets/...`, which already redirects to a signed URL — with Spaces it will redirect to a Spaces presigned URL, so big `.mov` files never stream through the server there either.
- Local LAN dev stays on disk (unchanged) since the Spaces vars are only set for the hosted app.
