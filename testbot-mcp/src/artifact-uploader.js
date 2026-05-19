/**
 * Artifact Uploader
 * Uploads test artifacts (screenshots, videos, traces) to backend storage
 * Uses multipart/form-data for efficient streaming and image compression
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const FormData = require('form-data');
const Logger = require('./logger');

// Phase D: anything matching these patterns MUST NEVER upload. Credentials
// stay on the user's machine.
//
//   auth-state-*.json  — storageState files written by credentials-injector
//   credentials.json   — raw creds blob (status-dir historical)
//   credentials-*      — any derivative naming
//
// Applied by fileName + fullPath so a state file copied anywhere still gets
// blocked.
const CREDENTIAL_DENY_PATTERNS = [
  /(?:^|[\\/])\.healix[\\/]auth-state-.*\.json$/,
  /(?:^|[\\/])auth-state-.*\.json$/,
  /(?:^|[\\/])credentials\.json$/,
  /(?:^|[\\/])credentials-.*$/,
];

function isCredentialFile(filePath, fileName) {
  const candidates = [filePath, fileName].filter(Boolean);
  return candidates.some((s) => CREDENTIAL_DENY_PATTERNS.some((rx) => rx.test(s)));
}

let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  Logger.warn('ArtifactUploader', 'sharp not installed - image compression disabled');
  sharp = null;
}

// Check if ffmpeg is available on system PATH
let ffmpegAvailable = false;
try {
  require('child_process').execSync('ffmpeg -version', { stdio: 'ignore' });
  ffmpegAvailable = true;
} catch (e) {
  Logger.warn('ArtifactUploader', 'ffmpeg not found in PATH - video compression disabled');
}

class ArtifactUploader {
  constructor(config = {}) {
    this.config = {
      projectPath: config.projectPath || process.cwd(),
      dashboardUrl: config.dashboardUrl || process.env.HEALIX_DASHBOARD_URL || 'http://localhost:3000',
      apiKey: config.apiKey || process.env.HEALIX_API_KEY,
      ...config,
    };
    
    Logger.info('ArtifactUploader', 'Initialized with config:', {
      projectPath: this.config.projectPath,
      dashboardUrl: this.config.dashboardUrl,
      apiKeyPresent: !!this.config.apiKey,
      apiKeyPrefix: this.config.apiKey ? this.config.apiKey.substring(0, 8) + '...' : 'MISSING',
    });
  }

  /**
   * Collect artifacts from test results (already parsed by playwright-integration)
   * Only collects artifacts for failed tests
   */
  collectFailureArtifacts(testResults) {
    const artifacts = [];
    
    Logger.info('ArtifactUploader', 'Starting artifact collection', {
      totalTests: testResults.tests?.length || 0,
      failedCount: (testResults.tests || []).filter(t => t.status === 'failed').length
    });
    
    // Get failed tests with their artifacts
    const failedTests = (testResults.tests || [])
      .filter(t => t.status === 'failed');
    
    if (failedTests.length === 0) {
      Logger.warn('ArtifactUploader', 'No failed tests found, skipping artifact collection');
      return artifacts;
    }

    Logger.info('ArtifactUploader', `Collecting artifacts for ${failedTests.length} failed tests`);

    // Extract artifacts from test results (already parsed by playwright-integration)
    for (const test of failedTests) {
      const testName = test.title || test.name || 'unknown-test';
      const testArtifacts = test.artifacts || {};
      
      Logger.debug('ArtifactUploader', `Test "${testName}" has artifacts:`, {
        screenshots: testArtifacts.screenshots?.length || 0,
        videos: testArtifacts.videos?.length || 0,
        traces: testArtifacts.traces?.length || 0,
      });
      
      // Process screenshots
      for (const screenshot of testArtifacts.screenshots || []) {
        const screenshotPath = screenshot.fullPath || screenshot.path;
        Logger.debug('ArtifactUploader', `Checking screenshot: ${screenshotPath}`);
        if (screenshotPath && fs.existsSync(screenshotPath)) {
          artifacts.push({
            fullPath: screenshotPath,
            fileName: path.basename(screenshotPath),
            type: 'screenshot',
            contentType: screenshot.contentType || 'image/png',
            testName,
          });
        } else {
          Logger.warn('ArtifactUploader', `Screenshot not found: ${screenshotPath}`);
        }
      }
      
      // Process videos
      for (const video of testArtifacts.videos || []) {
        const videoPath = video.fullPath || video.path;
        Logger.debug('ArtifactUploader', `Checking video: ${videoPath}`);
        if (videoPath && fs.existsSync(videoPath)) {
          artifacts.push({
            fullPath: videoPath,
            fileName: path.basename(videoPath),
            type: 'video',
            contentType: video.contentType || 'video/webm',
            testName,
          });
        } else {
          Logger.warn('ArtifactUploader', `Video not found: ${videoPath}`);
        }
      }
      
      // Process traces
      for (const trace of testArtifacts.traces || []) {
        const tracePath = trace.fullPath || trace.path;
        Logger.debug('ArtifactUploader', `Checking trace: ${tracePath}`);
        if (tracePath && fs.existsSync(tracePath)) {
          artifacts.push({
            fullPath: tracePath,
            fileName: path.basename(tracePath),
            type: 'trace',
            contentType: trace.contentType || 'application/zip',
            testName,
          });
        } else {
          Logger.warn('ArtifactUploader', `Trace not found: ${tracePath}`);
        }
      }
    }

    // Phase D: strip any credential file that snuck into test.artifacts.
    const beforeDeny = artifacts.length;
    for (let i = artifacts.length - 1; i >= 0; i -= 1) {
      if (isCredentialFile(artifacts[i].fullPath, artifacts[i].fileName)) {
        Logger.warn('ArtifactUploader', 'Deny-listed credential file excluded from artifacts', {
          fileName: artifacts[i].fileName,
        });
        artifacts.splice(i, 1);
      }
    }
    if (artifacts.length !== beforeDeny) {
      Logger.info('ArtifactUploader', `Deny-list removed ${beforeDeny - artifacts.length} credential file(s)`);
    }

    Logger.info('ArtifactUploader', `Collected ${artifacts.length} artifacts from ${failedTests.length} failed tests via test.artifacts`);
    
    // ALWAYS try filesystem fallback if no artifacts found from test.artifacts
    if (artifacts.length === 0 && failedTests.length > 0) {
      Logger.warn('ArtifactUploader', 'No artifacts found via test.artifacts property, scanning filesystem...');
      // Pass failed tests so we can map directory names to actual test titles
      const testTitleMap = {};
      for (const test of failedTests) {
        const title = test.title || test.name || 'unknown-test';
        // Create a normalized key from the title for matching
        const normalizedKey = title.toLowerCase().replace(/[^a-z0-9]/g, '');
        testTitleMap[normalizedKey] = title;
      }
      const fsArtifacts = this.collectFromFilesystem(failedTests, testTitleMap);
      Logger.info('ArtifactUploader', `Filesystem scan found ${fsArtifacts.length} artifacts`);
      return fsArtifacts;
    }
    
    return artifacts;
  }
  
  /**
   * Fallback: Scan filesystem for artifacts when test.artifacts is empty
   * @param {Array} failedTests - Array of failed test objects
   * @param {Object} testTitleMap - Map of normalized test names to actual titles
   */
  collectFromFilesystem(failedTests, testTitleMap = {}) {
    const artifacts = [];
    const testResultsDir = path.join(this.config.projectPath, 'test-results');
    
    if (!fs.existsSync(testResultsDir)) {
      Logger.warn('ArtifactUploader', 'test-results directory not found at:', testResultsDir);
      return artifacts;
    }
    
    Logger.info('ArtifactUploader', `Scanning ${testResultsDir} for artifacts (${failedTests.length} failed tests)`);
    Logger.debug('ArtifactUploader', `Test title map has ${Object.keys(testTitleMap).length} entries`);
    
    const scanDir = (dir) => {
      if (!fs.existsSync(dir)) return;
      
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          let type = null;
          let contentType = null;
          
          if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
            type = 'screenshot';
            contentType = ext === '.png' ? 'image/png' : 'image/jpeg';
          } else if (ext === '.webm' || ext === '.mp4') {
            type = 'video';
            contentType = ext === '.webm' ? 'video/webm' : 'video/mp4';
          } else if (ext === '.zip' && entry.name.includes('trace')) {
            type = 'trace';
            contentType = 'application/zip';
          }
          
          if (type) {
            // Extract test name from parent directory name
            // Playwright creates dirs like: "test-title-hash-browser"
            const parentDir = path.basename(path.dirname(fullPath));
            const dirBasedName = parentDir.split('-chromium')[0].split('-firefox')[0].split('-webkit')[0] || 'unknown-test';
            
            // Try to find the actual test title by matching against testTitleMap
            let actualTestTitle = dirBasedName; // fallback
            if (Object.keys(testTitleMap).length > 0) {
              // Normalize the directory name for matching
              const normalizedDir = dirBasedName.toLowerCase().replace(/[^a-z0-9]/g, '');
              
              // Find best match in testTitleMap
              for (const [normalizedKey, title] of Object.entries(testTitleMap)) {
                if (normalizedDir.includes(normalizedKey.substring(0, 20)) || 
                    normalizedKey.includes(normalizedDir.substring(0, 20))) {
                  actualTestTitle = title;
                  Logger.debug('ArtifactUploader', `Mapped directory "${dirBasedName}" to test title "${title}"`);
                  break;
                }
              }
            }
            
            artifacts.push({
              fullPath,
              fileName: entry.name,
              type,
              contentType,
              testName: actualTestTitle, // Use the actual test title, not directory name
            });
            
            Logger.debug('ArtifactUploader', `Found artifact: ${type} - ${entry.name} for test "${actualTestTitle}"`);
          }
        }
      }
    };
    
    scanDir(testResultsDir);
    
    Logger.info('ArtifactUploader', `Filesystem scan found ${artifacts.length} artifacts`);
    return artifacts;
  }


  /**
   * Compress image if it's a screenshot and sharp is available
   */
  async compressImage(filePath) {
    if (!sharp) {
      return fs.readFileSync(filePath);
    }

    try {
      const ext = path.extname(filePath).toLowerCase();
      if (ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg') {
        return fs.readFileSync(filePath);
      }

      const originalBuffer = fs.readFileSync(filePath);
      const originalSize = originalBuffer.length;

      // Compress with sharp: resize to max 1280px, quality 60, convert to JPEG for better compression
      const metadata = await sharp(originalBuffer).metadata();
      let compressor = sharp(originalBuffer)
        .resize(1280, null, { withoutEnlargement: true, fit: 'inside' });
      
      // Use JPEG for better compression (unless image has transparency)
      if (metadata.hasAlpha) {
        compressor = compressor.png({ quality: 60, compressionLevel: 9 });
      } else {
        compressor = compressor.jpeg({ quality: 60, mozjpeg: true });
      }
      
      const compressed = await compressor.toBuffer();

      const compressedSize = compressed.length;
      const savedPercent = Math.round((1 - compressedSize / originalSize) * 100);

      Logger.debug('ArtifactUploader', `Compressed ${path.basename(filePath)}: ${originalSize} → ${compressedSize} bytes (${savedPercent}% saved)`);
      
      return compressed;
    } catch (error) {
      Logger.warn('ArtifactUploader', `Image compression failed for ${filePath}, using original`, { error: error.message });
      return fs.readFileSync(filePath);
    }
  }

  /**
   * Compress video using ffmpeg (native child_process) with near-lossless encoding
   */
  async compressVideo(filePath) {
    if (!ffmpegAvailable) {
      return fs.readFileSync(filePath);
    }

    return new Promise((resolve) => {
      try {
        const ext = path.extname(filePath).toLowerCase();
        if (ext !== '.webm' && ext !== '.mp4') {
          resolve(fs.readFileSync(filePath));
          return;
        }

        const originalSize = fs.statSync(filePath).size;
        const outputPath = filePath.replace(/\.[^.]+$/, '_compressed.mp4');

        Logger.debug('ArtifactUploader', `Compressing video ${path.basename(filePath)}...`);

        // Call ffmpeg directly via spawn with very aggressive compression
        const ffmpegProcess = spawn('ffmpeg', [
          '-i', filePath,              // Input file
          '-c:v', 'libx264',           // H.264 codec
          '-crf', '32',                // Aggressive compression (32=smaller files, still acceptable)
          '-preset', 'medium',         // Balance speed/compression
          '-vf', 'scale=960:-2,fps=15',  // Resize to 960px width + reduce to 15fps
          '-c:a', 'aac',               // Re-encode audio to AAC for better compression
          '-b:a', '64k',               // Audio bitrate 64kbps (lower quality but smaller)
          '-movflags', '+faststart',   // Enable streaming
          '-y',                        // Overwrite output file
          outputPath
        ], {
          stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderr = '';
        ffmpegProcess.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        ffmpegProcess.on('close', (code) => {
          if (code === 0 && fs.existsSync(outputPath)) {
            try {
              const compressedSize = fs.statSync(outputPath).size;
              const savedPercent = Math.round((1 - compressedSize / originalSize) * 100);

              Logger.debug('ArtifactUploader', `Compressed ${path.basename(filePath)}: ${originalSize} → ${compressedSize} bytes (${savedPercent}% saved)`);
              
              const compressed = fs.readFileSync(outputPath);
              // Clean up temp file
              try { fs.unlinkSync(outputPath); } catch {}
              resolve(compressed);
            } catch (error) {
              Logger.warn('ArtifactUploader', `Failed to read compressed video, using original`, { error: error.message });
              try { fs.unlinkSync(outputPath); } catch {}
              resolve(fs.readFileSync(filePath));
            }
          } else {
            Logger.warn('ArtifactUploader', `Video compression failed (exit ${code}), using original`);
            try { fs.unlinkSync(outputPath); } catch {}
            resolve(fs.readFileSync(filePath));
          }
        });

        ffmpegProcess.on('error', (error) => {
          Logger.warn('ArtifactUploader', `Video compression error for ${filePath}, using original`, { error: error.message });
          try { fs.unlinkSync(outputPath); } catch {}
          resolve(fs.readFileSync(filePath));
        });
      } catch (error) {
        Logger.warn('ArtifactUploader', `Video compression setup error for ${filePath}, using original`, { error: error.message });
        resolve(fs.readFileSync(filePath));
      }
    });
  }

  /**
   * G68: Upload artifacts via per-file POSTs with concurrency cap.
   *
   * Pre-G68 we built one massive multipart body containing every artifact
   * (~70 files, ~50MB) and POSTed it all in a single request. Two failure
   * modes:
   *   1. busboy on the receiving side intermittently emits "Unexpected end
   *      of form" when the body straddles Node's stream-chunk boundaries
   *      mid-multipart.
   *   2. Vercel's 25MB body cap kills the whole batch on production.
   *
   * Per-file POSTs eliminate both: each request has exactly ONE artifact
   * (artifact_0 + artifact_0_meta), so each multipart body is small and
   * the busboy parser sees a complete, well-formed boundary every time.
   * Concurrency 4 keeps total wall-clock close to the old approach while
   * trading single-failure mode for partial-success semantics.
   */
  async uploadArtifacts(runId, artifacts) {
    Logger.info('ArtifactUploader', `uploadArtifacts called`, {
      runId,
      artifactCount: artifacts.length,
      hasApiKey: !!this.config.apiKey,
      dashboardUrl: this.config.dashboardUrl,
    });

    if (!this.config.apiKey) {
      Logger.error('ArtifactUploader', 'No API key configured, cannot upload artifacts');
      return { success: false, reason: 'no_api_key' };
    }

    if (artifacts.length === 0) {
      Logger.warn('ArtifactUploader', 'No artifacts to upload - collection found 0 artifacts');
      return { success: true, uploaded: 0, failed: 0 };
    }

    // Phase D deny-list belt-and-braces: filter credential files out before
    // we expand the workload.
    const filtered = artifacts.filter((a) => {
      if (isCredentialFile(a.fullPath, a.fileName)) {
        Logger.warn('ArtifactUploader', 'Refusing to upload credential file', { fileName: a.fileName });
        return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      return { success: true, uploaded: 0, failed: 0 };
    }

    Logger.info('ArtifactUploader',
      `Uploading ${filtered.length} artifact(s) one-per-request to ${this.config.dashboardUrl}/api/upload-artifacts (concurrency ${this.uploadConcurrency || 4})`);

    const fetchFn = require('node-fetch');
    const concurrency = Math.max(1, Math.min(this.uploadConcurrency || 4, 8));
    const failures = [];
    const successes = [];

    const uploadOne = async (artifact) => {
      // 1. Resolve the file bytes (with format-specific compression).
      let fileBuffer;
      try {
        if (artifact.type === 'screenshot') {
          fileBuffer = await this.compressImage(artifact.fullPath);
        } else if (artifact.type === 'video') {
          fileBuffer = await this.compressVideo(artifact.fullPath);
        } else {
          fileBuffer = fs.readFileSync(artifact.fullPath);
        }
      } catch (err) {
        return { ok: false, artifact, reason: 'read_failed', error: err?.message || String(err) };
      }

      // 2. Build a single-artifact multipart body using the SAME field
      // shape the existing /api/upload-artifacts route accepts.
      const form = new FormData();
      form.append('api_key', this.config.apiKey);
      form.append('run_id', runId);
      form.append('artifact_0', fileBuffer, {
        filename: artifact.fileName,
        contentType: artifact.contentType,
      });
      form.append('artifact_0_meta', JSON.stringify({
        test_name: artifact.testName,
        type: artifact.type,
        metadata: {
          file_size: fileBuffer.length,
          uploaded_at: new Date().toISOString(),
        },
      }));

      // 3. POST it. Retry once on 5xx (transient Supabase / Vercel hiccup).
      const headers = form.getHeaders ? form.getHeaders() : undefined;
      const url = `${this.config.dashboardUrl}/api/upload-artifacts`;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await fetchFn(url, { method: 'POST', body: form, ...(headers && { headers }) });
          if (response.ok) {
            return { ok: true, artifact };
          }
          const text = await response.text().catch(() => '');
          if (response.status >= 500 && attempt === 1) {
            // Transient — wait briefly and retry once.
            await new Promise((r) => setTimeout(r, 250));
            continue;
          }
          return { ok: false, artifact, reason: `http_${response.status}`, error: text };
        } catch (err) {
          if (attempt === 1) {
            await new Promise((r) => setTimeout(r, 250));
            continue;
          }
          return { ok: false, artifact, reason: 'network_error', error: err?.message || String(err) };
        }
      }
      return { ok: false, artifact, reason: 'unknown_failure' };
    };

    // Simple fixed-concurrency pool: walk the artifacts array with `concurrency`
    // workers, each pulling the next index. No third-party deps.
    let cursor = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const myIdx = cursor++;
        if (myIdx >= filtered.length) return;
        const result = await uploadOne(filtered[myIdx]);
        if (result.ok) {
          successes.push(result);
          Logger.debug('ArtifactUploader', `Uploaded ${result.artifact.fileName}`);
        } else {
          failures.push(result);
          Logger.warn('ArtifactUploader', `Upload failed for ${result.artifact.fileName}`, {
            reason: result.reason,
            error: result.error?.slice?.(0, 200),
          });
        }
      }
    });
    await Promise.all(workers);

    const uploaded = successes.length;
    const failed = failures.length;
    const success = uploaded > 0 && failed === 0;

    Logger.info('ArtifactUploader',
      `Per-file upload complete: ${uploaded} uploaded, ${failed} failed (of ${filtered.length})`);

    return {
      success,
      uploaded,
      failed,
      // Surface the first 5 failure reasons for diagnostics; don't dump
      // hundreds of stack traces.
      failureSamples: failures.slice(0, 5).map((f) => ({
        fileName: f.artifact.fileName,
        reason: f.reason,
        error: typeof f.error === 'string' ? f.error.slice(0, 200) : null,
      })),
      reason: success ? undefined : (failed === filtered.length ? 'all_failed' : 'partial_failure'),
    };
  }

  /**
   * Main method: collect and upload artifacts for failed tests
   */
  async processAndUpload(runId, testResults) {
    try {
      Logger.info('ArtifactUploader', `processAndUpload called for run ${runId}`);
      const artifacts = this.collectFailureArtifacts(testResults);
      Logger.info('ArtifactUploader', `Collected ${artifacts.length} artifacts, proceeding to upload`);
      
      if (artifacts.length === 0) {
        Logger.warn('ArtifactUploader', 'No artifacts collected - check if test-results directory exists and contains artifact files');
      }
      
      const result = await this.uploadArtifacts(runId, artifacts);
      Logger.info('ArtifactUploader', 'Upload completed', result);
      return result;
    } catch (error) {
      Logger.error('ArtifactUploader', 'processAndUpload failed with error:', error);
      return { success: false, reason: 'exception', error: error.message };
    }
  }
}

module.exports = ArtifactUploader;
module.exports.isCredentialFile = isCredentialFile;
module.exports.CREDENTIAL_DENY_PATTERNS = CREDENTIAL_DENY_PATTERNS;
