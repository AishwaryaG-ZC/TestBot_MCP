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
      dashboardUrl: config.dashboardUrl || process.env.TESTBOT_DASHBOARD_URL || 'http://localhost:3000',
      apiKey: config.apiKey || process.env.TESTBOT_API_KEY,
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
        Logger.debug('ArtifactUploader', `Checking screenshot: ${screenshot.path}`);
        if (screenshot.path && fs.existsSync(screenshot.path)) {
          artifacts.push({
            fullPath: screenshot.path,
            fileName: path.basename(screenshot.path),
            type: 'screenshot',
            contentType: screenshot.contentType || 'image/png',
            testName,
          });
        } else {
          Logger.warn('ArtifactUploader', `Screenshot not found: ${screenshot.path}`);
        }
      }
      
      // Process videos
      for (const video of testArtifacts.videos || []) {
        Logger.debug('ArtifactUploader', `Checking video: ${video.path}`);
        if (video.path && fs.existsSync(video.path)) {
          artifacts.push({
            fullPath: video.path,
            fileName: path.basename(video.path),
            type: 'video',
            contentType: video.contentType || 'video/webm',
            testName,
          });
        } else {
          Logger.warn('ArtifactUploader', `Video not found: ${video.path}`);
        }
      }
      
      // Process traces
      for (const trace of testArtifacts.traces || []) {
        Logger.debug('ArtifactUploader', `Checking trace: ${trace.path}`);
        if (trace.path && fs.existsSync(trace.path)) {
          artifacts.push({
            fullPath: trace.path,
            fileName: path.basename(trace.path),
            type: 'trace',
            contentType: trace.contentType || 'application/zip',
            testName,
          });
        } else {
          Logger.warn('ArtifactUploader', `Trace not found: ${trace.path}`);
        }
      }
    }

    Logger.info('ArtifactUploader', `Collected ${artifacts.length} artifacts from ${failedTests.length} failed tests via test.artifacts`);
    
    // ALWAYS try filesystem fallback if no artifacts found from test.artifacts
    if (artifacts.length === 0 && failedTests.length > 0) {
      Logger.warn('ArtifactUploader', 'No artifacts found via test.artifacts property, scanning filesystem...');
      const fsArtifacts = this.collectFromFilesystem(failedTests);
      Logger.info('ArtifactUploader', `Filesystem scan found ${fsArtifacts.length} artifacts`);
      return fsArtifacts;
    }
    
    return artifacts;
  }
  
  /**
   * Fallback: Scan filesystem for artifacts when test.artifacts is empty
   */
  collectFromFilesystem(failedTests) {
    const artifacts = [];
    const testResultsDir = path.join(this.config.projectPath, 'test-results');
    
    if (!fs.existsSync(testResultsDir)) {
      Logger.warn('ArtifactUploader', 'test-results directory not found at:', testResultsDir);
      return artifacts;
    }
    
    Logger.info('ArtifactUploader', `Scanning ${testResultsDir} for artifacts (${failedTests.length} failed tests)`);
    
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
            const testName = parentDir.split('-chromium')[0].split('-firefox')[0].split('-webkit')[0] || 'unknown-test';
            
            artifacts.push({
              fullPath,
              fileName: entry.name,
              type,
              contentType,
              testName,
            });
            
            Logger.debug('ArtifactUploader', `Found artifact: ${type} - ${entry.name}`);
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
   * Upload artifacts to backend storage using multipart/form-data
   */
  async uploadArtifacts(runId, artifacts) {
    Logger.info('ArtifactUploader', `uploadArtifacts called`, {
      runId,
      artifactCount: artifacts.length,
      hasApiKey: !!this.config.apiKey,
      dashboardUrl: this.config.dashboardUrl
    });
    
    if (!this.config.apiKey) {
      Logger.error('ArtifactUploader', 'No API key configured, cannot upload artifacts');
      return { success: false, reason: 'no_api_key' };
    }

    if (artifacts.length === 0) {
      Logger.warn('ArtifactUploader', 'No artifacts to upload - collection found 0 artifacts');
      return { success: true, uploaded: 0 };
    }

    // CRITICAL: Must use node-fetch, not global fetch
    // Global fetch doesn't handle form-data library streams properly
    const fetchFn = require('node-fetch');

    Logger.info('ArtifactUploader', `Uploading ${artifacts.length} artifacts to ${this.config.dashboardUrl} via multipart`);

    try {
      // Create multipart form data
      const form = new FormData();
      form.append('api_key', this.config.apiKey);
      form.append('run_id', runId);

      // Add each artifact as a file with metadata
      for (let i = 0; i < artifacts.length; i++) {
        const artifact = artifacts[i];
        
        // Compress based on type
        let fileBuffer;
        if (artifact.type === 'screenshot') {
          fileBuffer = await this.compressImage(artifact.fullPath);
        } else if (artifact.type === 'video') {
          fileBuffer = await this.compressVideo(artifact.fullPath);
        } else {
          fileBuffer = fs.readFileSync(artifact.fullPath);
        }

        // Append file
        form.append(`artifact_${i}`, fileBuffer, {
          filename: artifact.fileName,
          contentType: artifact.contentType,
        });

        // Append metadata as JSON string
        form.append(`artifact_${i}_meta`, JSON.stringify({
          test_name: artifact.testName,
          type: artifact.type,
          metadata: {
            file_size: fileBuffer.length,
            uploaded_at: new Date().toISOString(),
          },
        }));

        Logger.debug('ArtifactUploader', `Added artifact ${i}: ${artifact.fileName} (${fileBuffer.length} bytes)`);
      }

      // Upload with multipart/form-data
      // IMPORTANT: Don't set Content-Type header - let FormData set it with boundary
      const headers = form.getHeaders ? form.getHeaders() : undefined;
      
      const response = await fetchFn(`${this.config.dashboardUrl}/api/upload-artifacts`, {
        method: 'POST',
        body: form,
        ...(headers && { headers }), // Only include headers for node-fetch with form-data
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        Logger.error('ArtifactUploader', `Upload failed (HTTP ${response.status})`, { error: text });
        return { success: false, reason: `http_${response.status}`, error: text };
      }

      const result = await response.json();
      Logger.info('ArtifactUploader', `Successfully uploaded ${result.uploaded}/${result.total} artifacts (${result.failed || 0} failed)`);
      
      if (result.errors && result.errors.length > 0) {
        Logger.warn('ArtifactUploader', 'Some artifacts failed:', result.errors);
      }
      
      return { 
        success: result.uploaded > 0, 
        uploaded: result.uploaded,
        failed: result.failed || 0,
        artifacts: result.artifacts 
      };
    } catch (error) {
      Logger.error('ArtifactUploader', 'Upload failed', { error: error.message });
      return { success: false, reason: 'network_error', error: error.message };
    }
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
