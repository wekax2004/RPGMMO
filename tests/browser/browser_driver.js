/**
 * tests/browser/browser_driver.js
 * Puppeteer-Core Browser Driver for Tibia MMORPG Acceptance Testing
 *
 * Launches pre-installed Chrome or Edge on Windows,
 * manages browser contexts for multi-agent tests (e.g. trading),
 * and injects testing telemetry spies into page DOM contexts.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const activeBrowsers = new Set();

const CANDIDATE_BROWSER_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

/**
 * Discovers an existing browser binary on Windows host.
 * @returns {string} Absolute path to executable
 */
function findBrowserExecutable() {
  for (const candidate of CANDIDATE_BROWSER_PATHS) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `No supported browser binary found on host. Checked:\n  ${CANDIDATE_BROWSER_PATHS.join('\n  ')}`
  );
}

class BrowserDriver {
  constructor(options = {}) {
    this.options = Object.assign({
      port: 8080,
      headless: 'new', // 'new' | false
      viewport: { width: 1280, height: 720 },
      slowMo: 0
    }, options);

    this.browser = null;
    this.executablePath = null;
    // Uncaught client errors from every page this driver created, in order.
    // Accumulated on the driver so a test can check them after closing pages.
    this.clientErrors = [];
  }

  /**
   * Initializes and launches the browser process.
   * @returns {Promise<BrowserDriver>}
   */
  async init() {
    this.executablePath = findBrowserExecutable();

    this.browser = await puppeteer.launch({
      executablePath: this.executablePath,
      headless: this.options.headless === false ? false : 'new',
      slowMo: this.options.slowMo,
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--remote-allow-origins=*',
        `--window-size=${this.options.viewport.width},${this.options.viewport.height}`
      ]
    });
    activeBrowsers.add(this);

    if (!BrowserDriver._cleanupRegistered) {
      BrowserDriver._cleanupRegistered = true;
      const cleanup = () => {
        for (const driver of activeBrowsers) {
          if (!driver.browser) continue;
          try {
            const proc = driver.browser.process();
            if (proc && proc.pid && process.platform === 'win32') {
              const { spawnSync } = require('child_process');
              spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
            }
          } catch (e) {}
        }
      };
      process.once('exit', cleanup);
    }

    return this;
  }

  /**
   * Creates an isolated agent page in its own incognito browser context.
   * @param {object} agentOptions
   * @param {string} agentOptions.charName - Character name to log in
   * @param {string} agentOptions.classType - Class ('warrior' | 'mage' | 'ranger')
   * @param {boolean} agentOptions.autoLogin - Whether to perform login automatically
   * @returns {Promise<{context: object, page: object}>}
   */
  async createAgentPage(agentOptions = {}) {
    if (!this.browser) {
      await this.init();
    }

    const context = await this.browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport(this.options.viewport);

    // Collect uncaught client-side errors. Without this a ReferenceError in
    // ui.js/engine.js/renderer.js is invisible to every acceptance test, so a
    // feature can fail to render while the suite stays green. The listeners are
    // attached here, before navigation, so nothing is missed during load.
    const clientErrors = [];
    page.on('pageerror', (err) => {
      clientErrors.push(String((err && err.message) || err));
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') clientErrors.push('console.error: ' + msg.text());
    });
    // Exposed so a test can assert on it, e.g. getClientErrors(page).
    page.__clientErrors = clientErrors;
    // Also accumulated on the driver, so finalizeResult can still see them
    // after the test has closed the page.
    this.clientErrors.push(...clientErrors);
    this.clientErrorsPage = clientErrors;

    // Inject telemetry hooks before any page scripts execute
    await page.evaluateOnNewDocument(() => {
      window.__MMO_TEST_TELEMETRY__ = {
        socketPacketsIn: [],
        socketPacketsOut: [],
        renderFrames: [],
        telegraphRenders: []
      };

      // Transparent spy on WebSocket traffic
      const OriginalWebSocket = window.WebSocket;
      window.WebSocket = function(...args) {
        const ws = new OriginalWebSocket(...args);
        window.__GAME_SOCKET__ = ws;

        const origSend = ws.send;
        ws.send = function(data) {
          try {
            window.__MMO_TEST_TELEMETRY__.socketPacketsOut.push({
              time: Date.now(),
              data: typeof data === 'string' ? JSON.parse(data) : data
            });
          } catch (e) {}
          return origSend.apply(this, arguments);
        };

        ws.addEventListener('message', (event) => {
          try {
            window.__MMO_TEST_TELEMETRY__.socketPacketsIn.push({
              time: Date.now(),
              data: typeof event.data === 'string' ? JSON.parse(event.data) : event.data
            });
          } catch (e) {}
        });

        return ws;
      };
    });

    const targetUrl = `http://localhost:${this.options.port}/`;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });

    if (agentOptions.autoLogin && agentOptions.charName) {
      await this.loginAgent(page, agentOptions.charName, agentOptions.classType || 'warrior');
    }

    return { context, page };
  }

  /**
   * Executes UI character login on given page.
   * @param {object} page
   * @param {string} charName
   * @param {string} classType
   */
  async loginAgent(page, charName, classType = 'warrior') {
    await page.waitForSelector('#class-modal', { visible: true, timeout: 5000 });
    await page.type('#char-name', charName);

    // Click the class card corresponding to classType
    const clicked = await page.evaluate((cls) => {
      const cards = document.querySelectorAll('.class-card');
      for (const card of cards) {
        const onclickAttr = card.getAttribute('onclick') || '';
        if (onclickAttr.toLowerCase().includes(cls.toLowerCase())) {
          card.click();
          return true;
        }
      }
      // Fallback: click first class card
      if (cards.length > 0) {
        cards[0].click();
        return true;
      }
      return false;
    }, classType);

    if (!clicked) {
      throw new Error(`Failed to locate class card for class '${classType}'`);
    }

    await page.waitForSelector('#class-modal', { hidden: true, timeout: 5000 });
  }

  /**
   * Closes browser instance and releases system resources.
   * @returns {Promise<void>}
   */
  async close() {
    if (this.browser) {
      try {
        const proc = this.browser.process();
        const pid = proc ? proc.pid : null;
        await this.browser.close();
        if (pid && process.platform === 'win32') {
          try {
            process.kill(pid, 0);
            const { spawnSync } = require('child_process');
            spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
          } catch (e) {}
        }
      } catch (e) {}
      activeBrowsers.delete(this);
      this.browser = null;
    }
  }
}

/**
 * Returns the uncaught client-side errors recorded for a page.
 *
 * createAgentPage installs the listeners, so any test that drives the real UI
 * can call this to turn "the page threw" into a reported failure instead of a
 * silently blank panel.
 *
 * @param {object} page  a page returned by createAgentPage
 * @returns {string[]}   human-readable error descriptions, empty when clean
 */
function getClientErrors(page) {
  if (!page) return [];
  return Array.isArray(page.__clientErrors) ? page.__clientErrors.slice() : [];
}

/**
 * Wraps a test's result so an uncaught client-side error fails it.
 *
 * Acceptance tests assert on modals, canvas pixels and DOM state, none of
 * which notice that a handler threw on the way. That is how a panel can render
 * nothing while the suite stays green. Passing the result through here ties
 * "the page threw" to the test outcome.
 *
 * Usage:  return driver.finalize({ success, durationMs, results });
 *
 * @param {object} driver   the BrowserDriver that created the page
 * @param {object} result   the test result to finalize
 * @returns {object}        the same object, with success forced false on errors
 */
function finalizeResult(driver, result) {
  const errors = driver && Array.isArray(driver.clientErrors)
    ? driver.clientErrors.slice()
    : [];
  const finished = Object.assign({}, result);
  finished.clientErrors = errors;
  if (errors.length > 0) {
    finished.success = false;
    finished.clientErrorDetail = errors.slice(0, 5);
  }
  return finished;
}

module.exports = { BrowserDriver, findBrowserExecutable, getClientErrors, finalizeResult };
