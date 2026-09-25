/**
 * tests/lib/server_controller.js
 * Ephemeral Server Process Lifecycle Controller
 *
 * Spawns the Tibia MMORPG server on an isolated port,
 * monitors health and readiness via HTTP polling,
 * handles cross-platform graceful shutdowns (SIGINT, SIGTERM, IPC),
 * and provides cold restart capabilities for persistence tests.
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

class ServerController {
  constructor(options = {}) {
    this.port = options.port || 8085;
    this.host = options.host || '127.0.0.1';
    this.serverDir = options.serverDir || path.resolve(__dirname, '../../server');
    this.serverScript = options.serverScript || path.join(this.serverDir, 'server.js');
    this.env = options.env || {};
    this.dbFile = options.dbFile || path.join(os.tmpdir(), `tibia-mmo-test-${this.port}-${process.pid}.json`);
    this.child = null;
    this.stdout = [];
    this.stderr = [];
    this.isRunning = false;
  }

  /**
   * Spawns the server and waits for it to become ready to accept connections.
   * @param {number} timeoutMs
   * @returns {Promise<ServerController>}
   */
  async start(timeoutMs = 8000) {
    if (this.isRunning && this.child) {
      return this;
    }

    this.stdout = [];
    this.stderr = [];

    const env = Object.assign({}, process.env, {
      PORT: String(this.port),
      NODE_ENV: 'test',
      TIBIA_TEST_MODE: 'true',
      TIBIA_DB_DRIVER: 'local',
      TIBIA_DB_FILE: this.dbFile
    }, this.env);

    return new Promise((resolve, reject) => {
      let resolved = false;

      // Spawn Node server process with preload configuration hook
      const preloadPath = path.resolve(__dirname, 'server_preload.js');
      const nodeArgs = ['-r', preloadPath, this.serverScript];

      this.child = spawn(process.execPath, nodeArgs, {
        cwd: this.serverDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
      });

      this.child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        this.stdout.push(text);
      });

      this.child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        this.stderr.push(text);
      });

      this.child.on('error', (err) => {
        this.isRunning = false;
        if (!resolved) {
          resolved = true;
          reject(new Error(`Server process error: ${err.message}`));
        }
      });

      this.child.on('exit', (code, signal) => {
        this.isRunning = false;
        if (!resolved) {
          resolved = true;
          reject(new Error(`Server process exited prematurely with code ${code}, signal ${signal}`));
        }
      });

      // Poll HTTP endpoint until 200 OK or timeout
      const pollStart = Date.now();
      const pollInterval = 100;

      const poll = () => {
        if (resolved) return;
        if (Date.now() - pollStart > timeoutMs) {
          resolved = true;
          this.stop(true);
          return reject(new Error(`Timeout after ${timeoutMs}ms waiting for server on port ${this.port}. Stderr: ${this.stderr.join('')}`));
        }

        const req = http.get(`http://${this.host}:${this.port}/`, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => {
            const isTibia = res.statusCode === 200 && (
              body.includes('Tibia MMO') ||
              body.includes('Choose Your Path') ||
              body.includes('id="class-modal"')
            );
            if (isTibia) {
              resolved = true;
              this.isRunning = true;
              resolve(this);
            } else {
              setTimeout(poll, pollInterval);
            }
          });
        });

        req.on('error', () => {
          setTimeout(poll, pollInterval);
        });

        req.setTimeout(500, () => {
          req.destroy();
          setTimeout(poll, pollInterval);
        });
      };

      // Start polling after 200ms
      setTimeout(poll, 200);
    });
  }

  /**
   * Gracefully shuts down the server.
   * @param {boolean} force - Whether to immediately kill the process
   * @param {number} gracePeriodMs - Time to wait for clean exit before forcing
   * @returns {Promise<{code: number|null, signal: string|null}>}
   */
  async stop(force = false, gracePeriodMs = 4000) {
    if (!this.child || (!this.isRunning && !force)) {
      return { code: 0, signal: null };
    }

    return new Promise((resolve) => {
      let exited = false;

      const onExit = (code, signal) => {
        if (!exited) {
          exited = true;
          this.isRunning = false;
          this.child = null;
          resolve({ code, signal });
        }
      };

      this.child.once('exit', onExit);

      if (force) {
        try {
          const pid = this.child ? this.child.pid : null;
          if (pid && process.platform === 'win32') {
            const { spawnSync } = require('child_process');
            spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
          } else {
            this.child.kill('SIGKILL');
          }
        } catch (e) {
          // ignore
        }
        return;
      }

      let gracefulRequestSent = false;
      // Try IPC shutdown message first.
      try {
        if (this.child.connected) {
          this.child.send({ action: 'shutdown' });
          gracefulRequestSent = true;
        }
      } catch (e) {}

      // Try stdin command as a second graceful channel.
      try {
        if (this.child.stdin && !this.child.stdin.destroyed) {
          this.child.stdin.write('SHUTDOWN\n');
          gracefulRequestSent = true;
        }
      } catch (e) {}

      // Only send SIGINT when neither graceful channel was available.
      if (!gracefulRequestSent) {
        try {
          this.child.kill('SIGINT');
        } catch (e) {}
      }

      // Set timeout for hard termination if process hangs
      setTimeout(() => {
        if (!exited && this.child) {
          try {
            const pid = this.child.pid;
            if (pid && process.platform === 'win32') {
              const { spawnSync } = require('child_process');
              spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
            } else {
              this.child.kill('SIGKILL');
            }
          } catch (e) {}
        }
      }, gracePeriodMs);
    });
  }

  /**
   * Cold restarts the server on the same port.
   * @param {number} waitBeforeStartMs
   * @returns {Promise<ServerController>}
   */
  async restart(waitBeforeStartMs = 300) {
    await this.stop(false);
    if (waitBeforeStartMs > 0) {
      await new Promise(r => setTimeout(r, waitBeforeStartMs));
    }
    return await this.start();
  }

  /**
   * Retrieves concatenated stdout output.
   * @returns {string}
   */
  getStdout() {
    return this.stdout.join('');
  }

  /**
   * Retrieves concatenated stderr output.
   * @returns {string}
   */
  getStderr() {
    return this.stderr.join('');
  }
}

module.exports = ServerController;
