/**
 * Dashboard Launcher
 * Opens the test dashboard with the generated report
 * 
 * Note: Uses embedded data approach to avoid CORS issues with file:// protocol
 */

const fs = require('fs');
const path = require('path');
const Logger = require('./logger');

class DashboardLauncher {
  /**
   * Open the dashboard with the given report
   * @param {string} reportPath - Path to the report JSON file
   * @returns {string} Dashboard URL
   */
  static async open(reportPath) {
    // Find dashboard directory (relative to this module or in project)
    const dashboardPaths = [
      path.join(__dirname, '../../dashboard/public'),
      path.join(__dirname, '../../../dashboard/public'),
      path.join(process.cwd(), 'dashboard/public'),
      path.join(process.cwd(), 'node_modules/@testbot/mcp/dashboard/public'),
    ];

    let dashboardDir = null;
    for (const p of dashboardPaths) {
      if (fs.existsSync(path.join(p, 'index.html'))) {
        dashboardDir = p;
        break;
      }
    }

    if (!dashboardDir) {
      Logger.warn('DashboardLauncher', 'Dashboard not found, report saved at:', { path: reportPath });
      return reportPath;
    }

    const timestamp = Date.now();
    const destReportPath = path.join(dashboardDir, 'report.json');
    
    let reportData = null;
    let reportContent = '';
    
    try {
      // Read and validate the report first
      reportContent = fs.readFileSync(reportPath, 'utf-8');
      reportData = JSON.parse(reportContent);
      
      Logger.info('DashboardLauncher', `Report contains`, { 
        tests: reportData.stats?.total || 0, 
        project: reportData.metadata?.projectName || 'Unknown' 
      });
      
      // Write to dashboard directory (for HTTP server fallback)
      fs.writeFileSync(destReportPath, reportContent, 'utf-8');
      Logger.debug('DashboardLauncher', 'Report copied to dashboard');
      
      // Also save metadata about the report source
      const metadataPath = path.join(dashboardDir, 'report-metadata.json');
      fs.writeFileSync(metadataPath, JSON.stringify({
        sourceReport: reportPath,
        copiedAt: new Date().toISOString(),
        timestamp: timestamp,
        projectName: reportData.metadata?.projectName,
        testCount: reportData.stats?.total || 0
      }, null, 2), 'utf-8');
      
    } catch (error) {
      Logger.error('DashboardLauncher', 'Failed to copy report', error);
    }

    // Embed report data directly into HTML to avoid CORS issues with file:// protocol
    const embeddedDataPath = path.join(dashboardDir, 'embedded-report.js');
    try {
      // Create a JavaScript file that sets the report data as a global variable
      const embeddedScript = `// Auto-generated embedded report data - DO NOT EDIT
// Generated at: ${new Date().toISOString()}
// This file is used to bypass CORS restrictions when opening dashboard via file:// protocol
window.__TESTBOT_EMBEDDED_REPORT__ = ${reportContent || 'null'};
window.__TESTBOT_REPORT_TIMESTAMP__ = ${timestamp};
console.error('📊 Embedded report data loaded:', {
  project: window.__TESTBOT_EMBEDDED_REPORT__?.metadata?.projectName || 'Unknown',
  tests: window.__TESTBOT_EMBEDDED_REPORT__?.stats?.total || 0,
  timestamp: new Date(${timestamp}).toISOString()
});
`;
      fs.writeFileSync(embeddedDataPath, embeddedScript, 'utf-8');
      Logger.debug('DashboardLauncher', 'Embedded report data created (bypasses CORS)');
    } catch (error) {
      Logger.error('DashboardLauncher', 'Failed to create embedded report', error);
    }

    // Generate dashboard URL with cache-busting timestamp
    const dashboardUrl = `file://${path.join(dashboardDir, 'index.html')}?t=${timestamp}`;

    // Try to open in browser
    try {
      const { exec } = require('child_process');
      const cmd = process.platform === 'win32'
        ? `start "" "${dashboardUrl}"`
        : (process.platform === 'darwin' ? `open "${dashboardUrl}"` : `xdg-open "${dashboardUrl}"`);
      exec(cmd, { windowsHide: true }, () => {});
      Logger.info('DashboardLauncher', 'Opened in browser');
      Logger.info('DashboardLauncher', 'If dashboard shows old data, press Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows) to hard refresh');
    } catch (error) {
      // If exec fails, provide fallback instructions
      Logger.warn('DashboardLauncher', 'Could not auto-open browser', { url: dashboardUrl });
      Logger.info('DashboardLauncher', 'Use hard refresh (Cmd+Shift+R or Ctrl+Shift+R) if data looks stale');
    }

    return dashboardUrl;
  }
}

module.exports = DashboardLauncher;
