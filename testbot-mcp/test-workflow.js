#!/usr/bin/env node

/**
 * Test Workflow Script
 * Simulates the testbot MCP workflow for testing
 */

require('dotenv').config();

const path = require('path');
const AutoDetector = require('./src/auto-detector');
const PlaywrightIntegration = require('./src/playwright-integration');
const AIAnalyzer = require('./src/ai-providers/index');
const ReportGenerator = require('./src/report-generator');
const DashboardLauncher = require('./src/dashboard-launcher');

async function runTestWorkflow() {
  const log = (msg) => console.log(`[Testbot] ${msg}`);
  
  try {
    // Get project path from command line or use sample project
    const projectPath = process.argv[2] || path.join(__dirname, '../examples/sample-project');
    
    log('Starting Testbot MCP Workflow...');
    log(`Project Path: ${projectPath}`);
    
    // 1. Auto-detect project settings
    log('Step 1: Detecting project settings...');
    const detector = new AutoDetector();
    const context = await detector.detect(projectPath);
    
    log(`  Project: ${context.projectName}`);
    log(`  Port: ${context.port}`);
    log(`  Base URL: ${context.baseURL}`);
    log(`  Start Command: ${context.startCommand || 'None'}`);
    log(`  Test Dirs: ${context.testDirs.join(', ') || 'None'}`);
    
    // 2. Setup Playwright integration
    log('\nStep 2: Setting up Playwright...');
    const config = {
      projectPath: context.projectPath,
      projectName: context.projectName,
      testType: 'both',
      baseURL: context.baseURL,
      port: context.port,
      startCommand: context.startCommand,
      aiProvider: process.env.AI_PROVIDER || 'sarvam',
      aiApiKey: process.env.SARVAM_API_KEY || process.env.AI_API_KEY,
    };
    
    const playwright = new PlaywrightIntegration(config);
    
    // 3. Run tests
    log('\nStep 3: Running tests...');
    const testResults = await playwright.runTests();
    
    log(`  Total: ${testResults.total}`);
    log(`  Passed: ${testResults.passed}`);
    log(`  Failed: ${testResults.failed}`);
    log(`  Skipped: ${testResults.skipped}`);
    log(`  Duration: ${testResults.duration}ms`);
    
    // 4. AI Analysis (if failures)
    let aiAnalysis = null;
    if (testResults.failed > 0 && config.aiProvider !== 'none') {
      log(`\nStep 4: Analyzing ${testResults.failed} failures with ${config.aiProvider}...`);
      try {
        const analyzer = AIAnalyzer.create(config.aiProvider, config.aiApiKey);
        aiAnalysis = await analyzer.analyzeFailures(testResults.failures);
        log(`  Analyzed: ${aiAnalysis.length} failures`);
      } catch (error) {
        log(`  AI Analysis failed: ${error.message}`);
      }
    } else {
      log('\nStep 4: Skipping AI analysis (no failures or provider disabled)');
    }
    
    // 5. Generate report
    log('\nStep 5: Generating report...');
    const reportGen = new ReportGenerator();
    const report = await reportGen.generate({
      projectPath: config.projectPath,
      projectName: config.projectName,
      testResults,
      aiAnalysis,
      jiraData: null,
    });
    
    log(`  Report saved: ${report.path}`);
    
    // 6. Open dashboard
    log('\nStep 6: Opening dashboard...');
    try {
      const dashboardUrl = await DashboardLauncher.open(report.path);
      log(`  Dashboard: ${dashboardUrl}`);
    } catch (error) {
      log(`  Failed to open dashboard: ${error.message}`);
    }
    
    // Summary
    log('\n=== Workflow Complete ===');
    log(`Project: ${config.projectName}`);
    log(`Tests: ${testResults.passed}/${testResults.total} passed`);
    log(`Pass Rate: ${testResults.total > 0 ? Math.round((testResults.passed / testResults.total) * 100) : 0}%`);
    if (aiAnalysis) {
      log(`AI Analysis: ${aiAnalysis.length} failures analyzed`);
    }
    log(`Report: ${report.path}`);
    
  } catch (error) {
    console.error('\n[Error]', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

runTestWorkflow();
