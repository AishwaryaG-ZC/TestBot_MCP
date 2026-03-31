const ConfigUILauncher = require('./src/config-ui-launcher');

async function testBrowserOpen() {
  console.log('Testing browser auto-open on Windows...');
  console.log('Platform:', process.platform);
  
  const launcher = new ConfigUILauncher({ 
    autoOpenBrowser: true, 
    headless: true,
    timeout: 10000 // 10 seconds for quick test
  });
  
  try {
    const result = await launcher.launchNonBlocking({
      projectPath: __dirname,
      projectName: 'Test Project',
      baseURL: 'http://localhost:3000',
      startCommand: 'npm start',
      testType: 'frontend',
      headless: true
    });
    
    console.log('✓ Config UI launched successfully');
    console.log('  URL:', result.configUrl);
    console.log('  Auto-opened:', result.autoOpened);
    console.log('\nIf the browser opened, the fix is working!');
    console.log('Press Ctrl+C to exit...');
    
    // Keep the server running for a bit
    setTimeout(() => {
      launcher.cleanup();
      console.log('\nTest completed. Cleaning up...');
      process.exit(0);
    }, 5000);
    
  } catch (error) {
    console.error('✗ Error:', error.message);
    launcher.cleanup();
    process.exit(1);
  }
}

testBrowserOpen();
