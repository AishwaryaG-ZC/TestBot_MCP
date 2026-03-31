# Test Artifact Storage Setup

This document explains the artifact storage implementation for TestBot MCP.

## Overview

Test artifacts (screenshots, videos, traces) are now:
- ✅ **Captured only on test failure** (not for passing tests)
- ✅ **Uploaded to Supabase Storage** (cloud storage)
- ✅ **Stored with references in PostgreSQL** database
- ✅ **Accessible via public URLs** on the dashboard

## Configuration Required

### 1. Add Supabase Service Role Key

Add this to your `webapp/.env.local`:

```env
# Service role key for server-side operations (artifact uploads)
# Found in: Supabase Dashboard → Settings → API → service_role key
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Where to find it:**
1. Go to your Supabase Dashboard
2. Navigate to **Settings** → **API**
3. Copy the `service_role` key (NOT the anon key)
4. ⚠️ **Keep this secret!** Never commit it or expose it client-side

### 2. Run Database Migration

Generate and apply the migration for the new `test_artifacts` table:

```bash
cd webapp

# Generate migration from schema changes
npm run db:generate

# Apply migration to database
npm run db:push
```

This creates the `test_artifacts` table with columns:
- `id` (UUID, primary key)
- `test_run_id` (foreign key to test_runs)
- `test_name` (name of the failed test)
- `artifact_type` ('screenshot', 'video', or 'trace')
- `storage_url` (public Supabase Storage URL)
- `storage_path` (path in bucket)
- `file_name`, `file_size`, `content_type`
- `metadata` (JSONB for additional info)
- `created_at` (timestamp)

### 3. Create Supabase Storage Bucket

The bucket will be auto-created on first upload, but you can manually create it:

1. Go to Supabase Dashboard → **Storage**
2. Click **New bucket**
3. Name: `test-artifacts`
4. Make it **Public**
5. Set file size limit: **100MB**
6. Allowed MIME types:
   - `image/png`
   - `image/jpeg`
   - `video/webm`
   - `video/mp4`
   - `application/zip`
   - `application/json`

## How It Works

### 1. Playwright Configuration
Updated to capture artifacts only on failure:

```javascript
use: {
  trace: 'retain-on-failure',
  screenshot: 'only-on-failure',  // Changed from 'on'
  video: 'retain-on-failure',
}
```

### 2. MCP Pipeline Flow

After test execution:

1. **Collect artifacts** from `test-results/` directory
2. **Filter** to only include artifacts from failed tests
3. **Upload** to backend `/api/upload-artifacts` endpoint
4. **Backend** uploads to Supabase Storage
5. **Store** artifact URLs in `test_artifacts` table

### 3. Storage Structure

Artifacts are organized in Supabase Storage:

```
test-artifacts/
  {runId}/
    {testName}/
      screenshot/
        screenshot-1.png
        screenshot-2.png
      video/
        video.webm
      trace/
        trace.zip
```

### 4. API Endpoint

**POST** `/api/upload-artifacts`

Request:
```json
{
  "api_key": "tb_...",
  "run_id": "uuid",
  "artifacts": [
    {
      "test_name": "login-test",
      "type": "screenshot",
      "file_name": "screenshot.png",
      "content": "base64-encoded-content",
      "content_type": "image/png",
      "metadata": { "file_size": 12345 }
    }
  ]
}
```

Response:
```json
{
  "success": true,
  "uploaded": 3,
  "artifacts": [
    {
      "storage_url": "https://...supabase.co/storage/v1/object/public/test-artifacts/...",
      "storage_path": "runId/testName/screenshot/screenshot.png",
      "file_name": "screenshot.png",
      "file_size": 12345
    }
  ]
}
```

## Files Modified/Created

### Backend (webapp)
- ✅ `src/lib/db/schema.ts` - Added `test_artifacts` table
- ✅ `src/lib/storage/supabase-storage.ts` - Storage service (NEW)
- ✅ `src/app/api/upload-artifacts/route.ts` - Upload endpoint (NEW)
- ✅ `.env.example` - Added `SUPABASE_SERVICE_ROLE_KEY`

### MCP (testbot-mcp)
- ✅ `src/artifact-uploader.js` - Artifact collection & upload (NEW)
- ✅ `src/pipeline-worker.js` - Integrated artifact upload after tests
- ✅ `src/test-generator-openai.js` - Changed screenshot to 'only-on-failure'

## Next Steps (TODO)

1. **Update Dashboard UI** to display artifacts from Supabase URLs
   - Fetch artifacts from `test_artifacts` table
   - Display screenshots, videos, traces for failed tests
   - Add download/view functionality

2. **Add artifact cleanup** (optional)
   - Delete old artifacts after X days
   - Implement retention policy

3. **Add artifact compression** (optional)
   - Compress videos before upload
   - Optimize image sizes

## Testing

To test the artifact upload:

1. Run a test that will fail:
   ```bash
   # In your test project
   npx testbot-mcp test
   ```

2. Check logs for artifact upload:
   ```
   [ArtifactUploader] Collecting artifacts for 2 failed tests
   [ArtifactUploader] Uploaded 5 artifacts to http://localhost:3000
   ```

3. Verify in Supabase:
   - Go to **Storage** → `test-artifacts`
   - Check for uploaded files

4. Query database:
   ```sql
   SELECT * FROM test_artifacts ORDER BY created_at DESC LIMIT 10;
   ```

## Troubleshooting

**Artifacts not uploading?**
- Check `TESTBOT_API_KEY` is set in MCP config
- Check `TESTBOT_DASHBOARD_URL` is correct
- Check `SUPABASE_SERVICE_ROLE_KEY` is set in webapp `.env.local`
- Check backend logs for errors

**Bucket creation failed?**
- Manually create bucket in Supabase Dashboard
- Ensure service role key has storage permissions

**Upload size too large?**
- Videos can be large (10-50MB each)
- Increase bucket file size limit if needed
- Consider video compression
