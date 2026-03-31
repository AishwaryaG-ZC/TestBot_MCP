# Windows Config UI Fix - CONFIG_TIMEOUT Issue

## Problem
The configuration UI was timing out on Windows because the browser never opened automatically, causing the error:
```
Configuration timeout - user did not complete the form within 5 minutes
errorCode: CONFIG_TIMEOUT
```

## Root Cause
The `shouldAutoOpenBrowser()` method in `config-ui-launcher.js` was incorrectly prioritizing the `headless` parameter from `projectInfo` over the explicit `autoOpenBrowser: true` setting passed to the constructor.

**Flow:**
1. `index.js:1134` passes `autoOpenBrowser: true` to ConfigUILauncher constructor
2. `config-ui-launcher.js:60` defaults `headless: true` (from env or default)
3. `index.js:1149` passes `headless: true` to `launchNonBlocking()` projectInfo
4. `config-ui-launcher.js:148` checks `projectInfo.headless` first, returns `false` immediately
5. Browser never opens → timeout after 5 minutes

## Solution
Modified `shouldAutoOpenBrowser()` to respect the explicit `autoOpenBrowser: true` setting from the constructor, regardless of the `headless` parameter in projectInfo.

**Key insight:** The `headless` parameter is meant for Playwright test execution, NOT the config UI itself (as noted in the comment at `index.js:1132`).

### Changes Made

#### 1. Fixed `shouldAutoOpenBrowser()` logic
**File:** `src/config-ui-launcher.js:147-159`

```javascript
shouldAutoOpenBrowser(projectInfo = {}) {
  // If autoOpenBrowser was explicitly set in constructor config, respect it
  // The headless param in projectInfo is for Playwright execution, not config UI
  if (this.config.autoOpenBrowser === true) {
    return true;
  }
  
  const headless = resolveBoolean(projectInfo.headless, this.config.headless);
  if (headless) {
    return false;
  }
  return resolveBoolean(projectInfo.autoOpenBrowser, this.config.autoOpenBrowser);
}
```

#### 2. Enhanced Windows browser opening error handling
**File:** `src/config-ui-launcher.js:161-198`

Added:
- Explicit logging of the PowerShell command being executed
- stderr capture to diagnose PowerShell failures
- Error event handlers for spawn failures
- Exit code monitoring with detailed logging
- Platform information in all log messages

## Testing

Created `test/config-ui-autoopen.test.js` with three test cases:
1. ✅ Auto-open when `autoOpenBrowser=true` even with `headless=true`
2. ✅ Don't auto-open when headless without explicit autoOpenBrowser
3. ✅ Auto-open when not headless and `autoOpenBrowser=true`

All tests pass.

## Verification

To verify the fix works on Windows:
```bash
node test-browser-open.js
```

This will:
1. Launch the config UI with `autoOpenBrowser: true`
2. Attempt to open the browser on Windows
3. Log whether the browser opened successfully

## Expected Behavior After Fix

When `testbot_test_my_app` is called with `showConfigUI: true`:
1. Config UI server starts on port 54321
2. Browser automatically opens to the config form (on Windows via PowerShell)
3. User fills out and submits the form
4. Pipeline proceeds with user's configuration
5. No timeout errors

## Environment Variables

Users can control browser behavior via:
- `TESTBOT_HEADLESS` - Controls Playwright execution mode (default: true)
- `TESTBOT_AUTO_OPEN_BROWSER` - Forces browser auto-open (default: false)

**Note:** When MCP calls with `autoOpenBrowser: true` in code, it overrides these env vars.
