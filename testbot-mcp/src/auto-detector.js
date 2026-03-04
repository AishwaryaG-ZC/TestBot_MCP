/**
 * Auto-Detector
 * Automatically detects project settings from files and configuration.
 * Supports JavaScript/TypeScript, Python, Java, Go, Ruby, Rust, PHP, and more.
 */

const fs = require('fs');
const path = require('path');
const Logger = require('./logger');

class AutoDetector {
  /**
   * Detect project settings from the given path
   * @param {string} projectPath - Path to the project root
   * @returns {Object} Detected settings
   */
  async detect(projectPath) {
    const resolvedPath = path.resolve(projectPath);

    // Detect language and ecosystem first
    const langInfo = this.detectLanguageAndEcosystem(resolvedPath);

    // Read various config files
    const packageJson = this.readPackageJson(resolvedPath);
    const playwrightConfig = this.readPlaywrightConfig(resolvedPath);
    const envFile = this.readEnvFile(resolvedPath);

    // Detect settings (language-aware)
    const projectName = this.detectProjectName(resolvedPath, packageJson, langInfo);
    const port = this.detectPort(packageJson, envFile, playwrightConfig, langInfo);
    const baseURL = this.detectBaseURL(packageJson, envFile, playwrightConfig, port);
    const startCommand = this.detectStartCommand(packageJson, langInfo, resolvedPath);
    const testDirs = this.scanTestDirs(resolvedPath);

    const settings = {
      projectPath: resolvedPath,
      projectName,
      language: langInfo.language,
      ecosystem: langInfo.ecosystem,
      port,
      baseURL,
      startCommand,
      hasPlaywright: !!playwrightConfig,
      hasJira: this.detectJiraConfig(envFile),
      testDirs,
      packageJson,
      playwrightConfig,
    };

    Logger.debug('AutoDetector', 'Finished detection', { projectName, language: langInfo.language, hasPlaywright: settings.hasPlaywright });
    return settings;
  }

  /**
   * Detect project language and ecosystem from marker files
   */
  detectLanguageAndEcosystem(projectPath) {
    const markers = [
      // JavaScript / Node.js
      { file: 'package.json', language: 'javascript', ecosystem: 'node' },
      // Python
      { file: 'pyproject.toml', language: 'python', ecosystem: 'poetry' },
      { file: 'requirements.txt', language: 'python', ecosystem: 'pip' },
      { file: 'Pipfile', language: 'python', ecosystem: 'pipenv' },
      { file: 'setup.py', language: 'python', ecosystem: 'setuptools' },
      { file: 'manage.py', language: 'python', ecosystem: 'django' },
      // Java / Kotlin
      { file: 'pom.xml', language: 'java', ecosystem: 'maven' },
      { file: 'build.gradle', language: 'java', ecosystem: 'gradle' },
      { file: 'build.gradle.kts', language: 'kotlin', ecosystem: 'gradle' },
      // Go
      { file: 'go.mod', language: 'go', ecosystem: 'go-modules' },
      // Rust
      { file: 'Cargo.toml', language: 'rust', ecosystem: 'cargo' },
      // Ruby
      { file: 'Gemfile', language: 'ruby', ecosystem: 'bundler' },
      // PHP
      { file: 'composer.json', language: 'php', ecosystem: 'composer' },
      // Elixir
      { file: 'mix.exs', language: 'elixir', ecosystem: 'mix' },
      // Swift
      { file: 'Package.swift', language: 'swift', ecosystem: 'spm' },
      // C# / .NET
      { file: '*.csproj', language: 'csharp', ecosystem: 'dotnet' },
      { file: '*.sln', language: 'csharp', ecosystem: 'dotnet' },
      // Docker (fallback)
      { file: 'Dockerfile', language: 'docker', ecosystem: 'docker' },
    ];

    for (const marker of markers) {
      if (marker.file.includes('*')) {
        // Glob-style match for *.csproj, *.sln
        const ext = marker.file.replace('*', '');
        try {
          const entries = fs.readdirSync(projectPath);
          if (entries.some(e => e.endsWith(ext))) {
            return { language: marker.language, ecosystem: marker.ecosystem };
          }
        } catch (e) { /* ignore */ }
      } else if (fs.existsSync(path.join(projectPath, marker.file))) {
        return { language: marker.language, ecosystem: marker.ecosystem };
      }
    }

    return { language: 'unknown', ecosystem: 'unknown' };
  }

  /**
   * Detect project name from language-specific config files
   */
  detectProjectName(projectPath, packageJson, langInfo) {
    // Node.js
    if (packageJson?.name) return packageJson.name;

    // Python (pyproject.toml)
    if (langInfo.ecosystem === 'poetry' || langInfo.ecosystem === 'pip') {
      try {
        const pyproject = fs.readFileSync(path.join(projectPath, 'pyproject.toml'), 'utf-8');
        const nameMatch = pyproject.match(/name\s*=\s*"([^"]+)"/);
        if (nameMatch) return nameMatch[1];
      } catch (e) { /* ignore */ }
    }

    // Go (go.mod)
    if (langInfo.language === 'go') {
      try {
        const goMod = fs.readFileSync(path.join(projectPath, 'go.mod'), 'utf-8');
        const moduleMatch = goMod.match(/module\s+(\S+)/);
        if (moduleMatch) {
          const parts = moduleMatch[1].split('/');
          return parts[parts.length - 1];
        }
      } catch (e) { /* ignore */ }
    }

    // Java (pom.xml)
    if (langInfo.ecosystem === 'maven') {
      try {
        const pom = fs.readFileSync(path.join(projectPath, 'pom.xml'), 'utf-8');
        const artifactMatch = pom.match(/<artifactId>([^<]+)<\/artifactId>/);
        if (artifactMatch) return artifactMatch[1];
      } catch (e) { /* ignore */ }
    }

    // Rust (Cargo.toml)
    if (langInfo.language === 'rust') {
      try {
        const cargo = fs.readFileSync(path.join(projectPath, 'Cargo.toml'), 'utf-8');
        const nameMatch = cargo.match(/name\s*=\s*"([^"]+)"/);
        if (nameMatch) return nameMatch[1];
      } catch (e) { /* ignore */ }
    }

    // PHP (composer.json)
    if (langInfo.language === 'php') {
      try {
        const composer = JSON.parse(fs.readFileSync(path.join(projectPath, 'composer.json'), 'utf-8'));
        if (composer.name) {
          const parts = composer.name.split('/');
          return parts[parts.length - 1];
        }
      } catch (e) { /* ignore */ }
    }

    // Ruby (Gemfile - use directory name)
    // Elixir (mix.exs)
    if (langInfo.language === 'elixir') {
      try {
        const mix = fs.readFileSync(path.join(projectPath, 'mix.exs'), 'utf-8');
        const appMatch = mix.match(/app:\s*:(\w+)/);
        if (appMatch) return appMatch[1];
      } catch (e) { /* ignore */ }
    }

    // Fallback: directory name
    return path.basename(projectPath);
  }

  /**
   * Read package.json
   */
  readPackageJson(projectPath) {
    const packagePath = path.join(projectPath, 'package.json');
    try {
      if (fs.existsSync(packagePath)) {
        return JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
      }
    } catch (error) {
      Logger.debug('AutoDetector', `Failed to read package.json`, error);
    }
    return null;
  }

  /**
   * Read playwright.config.js
   */
  readPlaywrightConfig(projectPath) {
    const configPaths = [
      path.join(projectPath, 'playwright.config.js'),
      path.join(projectPath, 'playwright.config.ts'),
    ];

    for (const configPath of configPaths) {
      try {
        if (fs.existsSync(configPath)) {
          const content = fs.readFileSync(configPath, 'utf-8');
          return this.parsePlaywrightConfig(content);
        }
      } catch (error) {
        Logger.debug('AutoDetector', `Failed to read playwright config`, error);
      }
    }
    return null;
  }

  /**
   * Parse playwright config from file content
   */
  parsePlaywrightConfig(content) {
    const config = {};

    const baseURLMatch = content.match(/baseURL:\s*['"`]([^'"`]+)['"`]/);
    if (baseURLMatch) {
      config.baseURL = baseURLMatch[1];
    }

    const envBaseURLMatch = content.match(/baseURL:\s*process\.env\.([A-Z_]+)/);
    if (envBaseURLMatch) {
      config.baseURLEnvVar = envBaseURLMatch[1];
    }

    const testDirMatch = content.match(/testDir:\s*['"`]([^'"`]+)['"`]/);
    if (testDirMatch) {
      config.testDir = testDirMatch[1];
    }

    const projectsMatch = content.match(/projects:\s*\[([^\]]+)\]/s);
    if (projectsMatch) {
      config.hasProjects = true;
    }

    return config;
  }

  /**
   * Read .env file
   */
  readEnvFile(projectPath) {
    const envPath = path.join(projectPath, '.env');
    try {
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        const env = {};
        content.split('\n').forEach((line) => {
          const match = line.match(/^([A-Z_]+)=(.*)$/);
          if (match) {
            env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
          }
        });
        return env;
      }
    } catch (error) {
      Logger.debug('AutoDetector', `Failed to read .env`, error);
    }
    return null;
  }

  /**
   * Detect port number (language-aware)
   */
  detectPort(packageJson, envFile, playwrightConfig, langInfo) {
    // Check env file first
    if (envFile) {
      if (envFile.PORT) return parseInt(envFile.PORT, 10);
      if (envFile.APP_PORT) return parseInt(envFile.APP_PORT, 10);
    }

    // Check playwright config baseURL
    if (playwrightConfig?.baseURL) {
      const match = playwrightConfig.baseURL.match(/:(\d+)/);
      if (match) return parseInt(match[1], 10);
    }

    // Check package.json scripts for port hints (Node.js)
    if (packageJson?.scripts) {
      const scripts = JSON.stringify(packageJson.scripts);
      const portMatch = scripts.match(/--port[=\s](\d+)|PORT=(\d+)/);
      if (portMatch) {
        return parseInt(portMatch[1] || portMatch[2], 10);
      }
    }

    // Node.js framework defaults
    if (packageJson?.dependencies) {
      if (packageJson.dependencies.vite) return 5173;
      if (packageJson.dependencies.next) return 3000;
      if (packageJson.dependencies['create-react-app']) return 3000;
      if (packageJson.dependencies.express) return 3000;
    }

    // Language-specific defaults
    const langDefaults = {
      python: 8000,   // Django, FastAPI, Flask default
      java: 8080,     // Spring Boot, Tomcat default
      kotlin: 8080,
      go: 8080,
      ruby: 3000,     // Rails default
      php: 8000,      // Laravel artisan serve
      rust: 8080,
      csharp: 5000,   // ASP.NET default
      elixir: 4000,   // Phoenix default
    };

    if (langInfo?.language && langDefaults[langInfo.language]) {
      return langDefaults[langInfo.language];
    }

    return 8000; // Default fallback
  }

  /**
   * Detect base URL
   */
  detectBaseURL(packageJson, envFile, playwrightConfig, port) {
    if (envFile) {
      if (envFile.BASE_URL) return envFile.BASE_URL;
      if (envFile.APP_URL) return envFile.APP_URL;
    }

    if (playwrightConfig?.baseURL && !playwrightConfig.baseURL.includes('process.env')) {
      return playwrightConfig.baseURL;
    }

    return `http://localhost:${port}`;
  }

  /**
   * Detect start command (language-aware)
   */
  detectStartCommand(packageJson, langInfo, projectPath) {
    // Node.js: check package.json scripts
    if (packageJson?.scripts) {
      const scripts = packageJson.scripts;
      const startScripts = ['dev', 'start', 'serve', 'start:dev', 'develop'];
      for (const script of startScripts) {
        if (scripts[script]) {
          return `npm run ${script}`;
        }
      }
    }

    // Language-specific start commands
    if (langInfo?.language === 'python') {
      if (langInfo.ecosystem === 'django' || fs.existsSync(path.join(projectPath, 'manage.py'))) {
        return 'python manage.py runserver';
      }
      // Check for FastAPI / Uvicorn
      try {
        const req = fs.readFileSync(path.join(projectPath, 'requirements.txt'), 'utf-8');
        if (req.includes('fastapi') || req.includes('uvicorn')) {
          return 'uvicorn main:app --reload';
        }
        if (req.includes('flask')) {
          return 'flask run';
        }
      } catch (e) { /* ignore */ }
      try {
        const pyproject = fs.readFileSync(path.join(projectPath, 'pyproject.toml'), 'utf-8');
        if (pyproject.includes('fastapi') || pyproject.includes('uvicorn')) {
          return 'uvicorn main:app --reload';
        }
        if (pyproject.includes('flask')) {
          return 'flask run';
        }
        if (pyproject.includes('django')) {
          return 'python manage.py runserver';
        }
      } catch (e) { /* ignore */ }
      return 'python -m http.server';
    }

    if (langInfo?.language === 'java') {
      if (langInfo.ecosystem === 'maven') return 'mvn spring-boot:run';
      if (langInfo.ecosystem === 'gradle') return './gradlew bootRun';
    }

    if (langInfo?.language === 'go') return 'go run .';
    if (langInfo?.language === 'ruby') return 'rails server';
    if (langInfo?.language === 'rust') return 'cargo run';
    if (langInfo?.language === 'php') return 'php artisan serve';
    if (langInfo?.language === 'elixir') return 'mix phx.server';
    if (langInfo?.language === 'csharp') return 'dotnet run';

    return null;
  }

  /**
   * Detect Jira configuration
   */
  detectJiraConfig(envFile) {
    if (!envFile) return false;

    return !!(
      envFile.JIRA_BASE_URL ||
      envFile.JIRA_API_TOKEN ||
      envFile.JIRA_PROJECT_KEY
    );
  }

  /**
   * Scan for test directories
   */
  scanTestDirs(projectPath) {
    const testDirs = [];
    const possibleDirs = ['tests', 'test', '__tests__', 'spec', 'specs', 'e2e'];

    for (const dir of possibleDirs) {
      const fullPath = path.join(projectPath, dir);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        testDirs.push(dir);

        const subDirs = ['frontend', 'backend', 'api', 'e2e', 'unit', 'integration'];
        for (const subDir of subDirs) {
          const subPath = path.join(fullPath, subDir);
          if (fs.existsSync(subPath) && fs.statSync(subPath).isDirectory()) {
            testDirs.push(`${dir}/${subDir}`);
          }
        }
      }
    }

    return testDirs;
  }
}

module.exports = AutoDetector;
