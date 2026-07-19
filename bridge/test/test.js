#!/usr/bin/env node
/**
 * LiftOff Antigravity Bridge - Validation Test Suite
 * Run: node test.js
 *
 * Tests:
 *  1. Environment checks (Node.js, npm, .env)
 *  2. Dependencies installed
 *  3. Server syntax validation
 *  4. Port availability
 *  5. CDP connectivity
 *  6. Server startup + HTTP endpoints
 *  7. WebSocket connectivity
 */
import http from 'http';
import https from 'https';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync, spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

// --- Config ---
const CDP_PORTS = [7800, 7801, 7802, 7803];
const SERVER_PORT = process.env.PORT || 4747;
const c = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
    cyan: '\x1b[36m', magenta: '\x1b[35m',
};

let passed = 0;
let failed = 0;
let warnings = 0;

function pass(msg) { console.log(`  ${c.green}✓${c.reset} ${msg}`); passed++; }
function fail(msg) { console.log(`  ${c.red}✗${c.reset} ${msg}`); failed++; }
function warn(msg) { console.log(`  ${c.yellow}⚠${c.reset} ${msg}`); warnings++; }
function section(title) { console.log(`\n${c.cyan}${c.bold}▸ ${title}${c.reset}`); }

function httpGet(url, timeout = 3000) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const client = target.protocol === 'https:' ? https : http;
        const req = client.get(url, {
            timeout,
            rejectUnauthorized: false
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function waitForHttp(url, timeout = 20000) {
    const deadline = Date.now() + timeout;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            return await httpGet(url, 2000);
        } catch (error) {
            lastError = error;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    throw lastError || new Error('server startup timeout');
}

function httpRequest(method, url, { headers = {}, body = null, timeout = 3000 } = {}) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const client = target.protocol === 'https:' ? https : http;
        const req = client.request(url, {
            method,
            timeout,
            rejectUnauthorized: false,
            headers
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (body) req.write(body);
        req.end();
    });
}

function isPortAvailable(port) {
    return new Promise((resolve) => {
        const server = http.createServer();
        server.on('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => {
            server.close(() => resolve(true));
        });
    });
}

async function main() {
    console.log('');
    console.log(`${c.magenta}${c.bold}  ╔══════════════════════════════════════════╗${c.reset}`);
    console.log(`${c.magenta}${c.bold}  ║  LiftOff Antigravity Bridge - Tests      ║${c.reset}`);
    console.log(`${c.magenta}${c.bold}  ╚══════════════════════════════════════════╝${c.reset}`);

    // ─── 1. Environment ───────────────────────────────────────
    section('Environment');

    // Node.js version
    const nodeVersion = process.version;
    const nodeMajor = parseInt(nodeVersion.slice(1));
    if (nodeMajor >= 16) pass(`Node.js ${nodeVersion} (≥16 required)`);
    else fail(`Node.js ${nodeVersion} — v16+ required`);

    // npm
    try {
        const npmVer = execSync('npm --version', { encoding: 'utf8' }).trim();
        pass(`npm ${npmVer}`);
    } catch { fail('npm not found'); }

    // .env file
    const envPath = join(PROJECT_ROOT, '.env');
    if (fs.existsSync(envPath)) {
        pass('.env file exists');
        const envContent = fs.readFileSync(envPath, 'utf8');
        if (envContent.includes('APP_PASSWORD=') && !envContent.includes('APP_PASSWORD=your-app-password')) {
            pass('APP_PASSWORD is configured');
        } else {
            warn('APP_PASSWORD is using default — change it for security');
        }
        const portMatch = envContent.match(/PORT=(\d+)/);
        if (portMatch) {
            pass(`Server port configured: ${portMatch[1]}`);
        }
    } else {
        warn('.env file missing (will use defaults)');
    }

    // ─── 2. Dependencies ──────────────────────────────────────
    section('Dependencies');

    const nodeModules = join(PROJECT_ROOT, 'node_modules');
    if (fs.existsSync(nodeModules)) {
        pass('node_modules/ directory exists');
    } else {
        fail('node_modules/ missing — run: npm install');
    }

    const requiredPkgs = ['express', 'ws', 'compression', 'cookie-parser', 'dotenv', 'qrcode-terminal'];
    for (const pkg of requiredPkgs) {
        const pkgPath = join(nodeModules, pkg);
        if (fs.existsSync(pkgPath)) pass(`${pkg} installed`);
        else fail(`${pkg} missing — run: npm install`);
    }

    // ─── 3. Syntax Validation ─────────────────────────────────
    section('Syntax Validation');

    const filesToCheck = [
        'src/server.js',
        'src/language-server/rpc-client.js',
        'src/language-server/conversation-disk-store.js',
        'src/language-server/conversation-read-service.js',
        'src/language-server/conversation-write-service.js',
        'src/supervisor.js',
        'src/quota-service.js',
        'src/screenshot-timeline.js',
        'src/utils/workspace.js',
        'scripts/cloudflare-tunnel.js',
        'scripts/probe-language-server.js',
        'launcher.js'
    ];
    for (const file of filesToCheck) {
        try {
            execSync(`node --check ${file}`, { cwd: PROJECT_ROOT, stdio: 'pipe' });
            pass(`${file} — syntax OK`);
        } catch (e) {
            fail(`${file} — syntax error: ${e.stderr?.toString().trim()}`);
        }
    }

    // Check required app-only setup and launcher files.
    const frontendFiles = [
        'public/download.html',
        'public/mobile-app.json',
        'public/css/download.css',
        'public/js/download.js',
        'public/icons/liftoff-icon.png',
        'src/utils/desktop-control.js',
        'src/utils/http-cache.js',
        'windows/LiftOffLauncher.cs',
        'windows/build-launcher.ps1'
    ];
    for (const f of frontendFiles) {
        if (fs.existsSync(join(PROJECT_ROOT, f))) pass(`${f} exists`);
        else fail(`${f} missing`);
    }

    // ─── 4. Port Availability ─────────────────────────────────
    section('Port Availability');

    const serverPortFree = await isPortAvailable(parseInt(SERVER_PORT));
    if (serverPortFree) pass(`Server port ${SERVER_PORT} is available`);
    else warn(`Server port ${SERVER_PORT} is in use — server may fail to start`);

    // ─── 5. CDP Connectivity ──────────────────────────────────
    section('CDP Connectivity (Antigravity Debug Port)');

    let cdpFound = false;
    for (const port of CDP_PORTS) {
        try {
            const res = await httpGet(`http://127.0.0.1:${port}/json/list`, 2000);
            const targets = JSON.parse(res.data);
            if (Array.isArray(targets) && targets.length > 0) {
                pass(`Port ${port} — ${targets.length} target(s) found`);
                for (const t of targets) {
                    if (t.url?.includes('workbench') || t.title?.includes('workbench')) {
                        pass(`  └─ Workbench target: "${t.title}"`);
                        cdpFound = true;
                    }
                }
            } else {
                warn(`Port ${port} — responding but no targets`);
            }
        } catch (e) {
            if (e.message === 'timeout') {
                console.log(`  ${c.dim}  Port ${port} — timeout (not listening)${c.reset}`);
            } else {
                console.log(`  ${c.dim}  Port ${port} — ${e.message.split('\n')[0]}${c.reset}`);
            }
        }
    }

    if (!cdpFound) {
        warn('No Antigravity CDP detected — launch with: agd');
        warn('  Or manually: antigravity . --remote-debugging-port=7800');
    }

    // ─── 6. Server Integration Test ───────────────────────────
    section('Server Integration Test');

    if (!serverPortFree) {
        warn('Skipping server test — port in use');
    } else {
        const sslEnabled = fs.existsSync(join(PROJECT_ROOT, 'certs', 'server.key')) &&
            fs.existsSync(join(PROJECT_ROOT, 'certs', 'server.cert'));
        const baseProtocol = sslEnabled ? 'https' : 'http';
        const wsProtocol = sslEnabled ? 'wss' : 'ws';

        const serverProc = spawn('node', ['src/server.js'], {
            cwd: PROJECT_ROOT,
            env: { ...process.env, PORT: String(SERVER_PORT) },
            // The bridge prints QR and discovery diagnostics. Leaving unread
            // pipes here can backpressure the child during long RPC warm-up.
            stdio: ['ignore', 'ignore', 'inherit']
        });
        serverProc.once('exit', (code, signal) => {
            if (code !== 0 || signal) {
                console.error(`  Isolated bridge exited (code=${code}, signal=${signal})`);
            }
        });

        try {
            // Test main page
            const mainRes = await waitForHttp(`${baseProtocol}://127.0.0.1:${SERVER_PORT}/`);
            if (mainRes.status === 200) pass(`GET / → 200 (main page)`);
            else if (mainRes.status === 302 || mainRes.status === 301) pass(`GET / → ${mainRes.status} (redirect to login)`);
            else fail(`GET / → ${mainRes.status}`);

            const downloadRes = await httpGet(`${baseProtocol}://127.0.0.1:${SERVER_PORT}/download`);
            if (
                downloadRes.status === 200 &&
                downloadRes.data.includes('Download LiftOff for Android') &&
                downloadRes.data.includes('Manage the launch pad')
            ) {
                pass(`GET /download - 200 (mobile release page)`);
            } else {
                fail(`GET /download - ${downloadRes.status}`);
            }

            const mobileMetadataRes = await httpGet(`${baseProtocol}://127.0.0.1:${SERVER_PORT}/mobile-app.json`);
            if (mobileMetadataRes.status === 200) {
                const metadata = JSON.parse(mobileMetadataRes.data);
                if (metadata.version && metadata.downloadUrl === '/liftoff.apk') {
                    pass(`GET /mobile-app.json - 200 (v${metadata.version})`);
                } else {
                    fail('GET /mobile-app.json - invalid release metadata');
                }
            } else {
                fail(`GET /mobile-app.json - ${mobileMetadataRes.status}`);
            }

            const desktopStatusRes = await httpGet(
                `${baseProtocol}://127.0.0.1:${SERVER_PORT}/api/desktop/status`
            );
            if (desktopStatusRes.status === 200) {
                const desktopStatus = JSON.parse(desktopStatusRes.data);
                if (desktopStatus.running === true && typeof desktopStatus.managed === 'boolean') {
                    pass('GET /api/desktop/status - 200 (safe bridge status)');
                } else {
                    fail('GET /api/desktop/status - invalid response shape');
                }
            } else {
                fail(`GET /api/desktop/status - ${desktopStatusRes.status}`);
            }

            const lockedLogsRes = await httpRequest(
                'GET',
                `${baseProtocol}://127.0.0.1:${SERVER_PORT}/api/desktop/logs`
            );
            if (lockedLogsRes.status === 401) {
                pass('GET /api/desktop/logs - password required on localhost');
            } else {
                fail(`GET /api/desktop/logs without password - ${lockedLogsRes.status}`);
            }

            const envContents = fs.existsSync(join(PROJECT_ROOT, '.env'))
                ? fs.readFileSync(join(PROJECT_ROOT, '.env'), 'utf8')
                : '';
            const configuredPassword = process.env.APP_PASSWORD ||
                envContents.match(/^APP_PASSWORD=(.*)$/m)?.[1]?.trim() ||
                'antigravity';
            const unlockedLogsRes = await httpRequest(
                'GET',
                `${baseProtocol}://127.0.0.1:${SERVER_PORT}/api/desktop/logs`,
                { headers: { 'X-LiftOff-Password': configuredPassword } }
            );
            if (unlockedLogsRes.status === 200 && Array.isArray(JSON.parse(unlockedLogsRes.data).logs)) {
                pass('GET /api/desktop/logs - 200 with bridge password');
            } else {
                fail(`GET /api/desktop/logs with password - ${unlockedLogsRes.status}`);
            }

            // Test snapshot endpoint
            const snapRes = await httpGet(
                `${baseProtocol}://127.0.0.1:${SERVER_PORT}/snapshot`,
                90000
            );
            if (snapRes.status === 200 || snapRes.status === 503) pass(`GET /snapshot → ${snapRes.status} (expected)`);
            else fail(`GET /snapshot → ${snapRes.status}`);

            if (snapRes.status === 200 && snapRes.headers.etag) {
                const unchangedSnapshotRes = await httpRequest(
                    'GET',
                    `${baseProtocol}://127.0.0.1:${SERVER_PORT}/snapshot`,
                    { headers: { 'If-None-Match': snapRes.headers.etag } }
                );
                if (unchangedSnapshotRes.status === 304) {
                    pass('GET /snapshot - 304 for unchanged revision');
                } else {
                    fail(`GET /snapshot conditional - ${unchangedSnapshotRes.status}`);
                }
            }

            // Test CDP targets endpoint
            const targetsRes = await httpGet(`${baseProtocol}://127.0.0.1:${SERVER_PORT}/cdp-targets`);
            if (targetsRes.status === 200) {
                const data = JSON.parse(targetsRes.data);
                pass(`GET /cdp-targets → 200 (${data.targets?.length || 0} targets)`);
            } else {
                fail(`GET /cdp-targets → ${targetsRes.status}`);
            }

            // Test app-state endpoint
            const stateRes = await httpGet(`${baseProtocol}://127.0.0.1:${SERVER_PORT}/app-state`);
            if (stateRes.status === 200) pass(`GET /app-state → 200`);
            else fail(`GET /app-state → ${stateRes.status}`);

            const historyRes = await httpGet(
                `${baseProtocol}://127.0.0.1:${SERVER_PORT}/chat-history`,
                90000
            );
            if (historyRes.status === 200) {
                const history = JSON.parse(historyRes.data);
                if (Array.isArray(history.projects) && Array.isArray(history.chats)) {
                    pass(`GET /chat-history - 200 (${history.source || 'cdp'} source)`);
                    const structuredSnapshotRes = await httpGet(
                        `${baseProtocol}://127.0.0.1:${SERVER_PORT}/snapshot`,
                        90000
                    );
                    if (history.source === 'language-server-rpc' && structuredSnapshotRes.status === 200) {
                        const structuredSnapshot = JSON.parse(structuredSnapshotRes.data);
                        if (structuredSnapshot.source === 'language-server-rpc') {
                            pass('GET /snapshot - RPC semantic transcript');
                            if (structuredSnapshotRes.headers.etag) {
                                const cachedSnapshotRes = await httpRequest(
                                    'GET',
                                    `${baseProtocol}://127.0.0.1:${SERVER_PORT}/snapshot`,
                                    {
                                        headers: {
                                            'If-None-Match': structuredSnapshotRes.headers.etag
                                        }
                                    }
                                );
                                if (cachedSnapshotRes.status === 304) {
                                    pass('GET /snapshot - RPC revision returns 304');
                                } else {
                                    fail(
                                        `GET /snapshot RPC conditional - ${cachedSnapshotRes.status}`
                                    );
                                }
                            } else {
                                fail('GET /snapshot RPC response did not include an ETag');
                            }
                        } else {
                            fail('GET /snapshot did not preserve the RPC read source');
                        }
                    } else if (history.source !== 'language-server-rpc') {
                        warn('Conversation routes used the documented CDP fallback');
                    }
                } else {
                    fail('GET /chat-history - invalid response shape');
                }
            } else {
                fail(`GET /chat-history - ${historyRes.status}`);
            }

            const invalidMediaRes = await httpGet(
                `${baseProtocol}://127.0.0.1:${SERVER_PORT}/api/conversations/test/media/not-a-step/0`
            );
            if (invalidMediaRes.status === 400) {
                pass('GET /api/conversations/:id/media - validates references');
            } else {
                fail(`GET /api/conversations/:id/media validation - ${invalidMediaRes.status}`);
            }

            const invalidChangesRes = await httpGet(
                `${baseProtocol}://127.0.0.1:${SERVER_PORT}/api/conversations/test/changes/not-a-step`
            );
            if (invalidChangesRes.status === 400) {
                pass('GET /api/conversations/:id/changes - validates references');
            } else {
                fail(`GET /api/conversations/:id/changes validation - ${invalidChangesRes.status}`);
            }

            // Test quota endpoint
            const quotaRes = await httpGet(`${baseProtocol}://127.0.0.1:${SERVER_PORT}/api/quota`);
            if (quotaRes.status === 200) {
                const data = JSON.parse(quotaRes.data);
                pass(`GET /api/quota → 200 (${data.totalModels || 0} models)`);
            } else {
                fail(`GET /api/quota → ${quotaRes.status}`);
            }

            const timelineRes = await httpGet(`${baseProtocol}://127.0.0.1:${SERVER_PORT}/api/timeline`);
            if (timelineRes.status === 200) {
                const data = JSON.parse(timelineRes.data);
                pass(`GET /api/timeline → 200 (${data.totalEntries || 0} captures)`);

                if (Array.isArray(data.entries) && data.entries.length > 0) {
                    const imageRes = await httpGet(`${baseProtocol}://127.0.0.1:${SERVER_PORT}${data.entries[0].url}`);
                    if (imageRes.status === 200) pass(`GET /api/timeline/:filename → 200`);
                    else fail(`GET /api/timeline/:filename → ${imageRes.status}`);
                }
            } else {
                fail(`GET /api/timeline → ${timelineRes.status}`);
            }

            if (cdpFound) {
                const timelineCaptureRes = await httpRequest('POST', `${baseProtocol}://127.0.0.1:${SERVER_PORT}/api/timeline/capture`, {
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reason: 'smoke-test' }),
                    timeout: 10000
                });
                if (timelineCaptureRes.status === 200 || timelineCaptureRes.status === 503) {
                    pass(`POST /api/timeline/capture → ${timelineCaptureRes.status}`);
                } else {
                    fail(`POST /api/timeline/capture → ${timelineCaptureRes.status}`);
                }
            } else {
                warn('Skipping timeline capture - no Antigravity CDP workbench target detected');
            }

            const assistHistoryRes = await httpGet(`${baseProtocol}://127.0.0.1:${SERVER_PORT}/api/assist/history`);
            if (assistHistoryRes.status === 200) pass(`GET /api/assist/history → 200`);
            else fail(`GET /api/assist/history → ${assistHistoryRes.status}`);

            const assistChatRes = await httpRequest('POST', `${baseProtocol}://127.0.0.1:${SERVER_PORT}/api/assist/chat`, {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'Give me a quick session summary.' })
            });
            if (assistChatRes.status === 200) {
                const data = JSON.parse(assistChatRes.data);
                if (typeof data.reply === 'string' && Array.isArray(data.history)) {
                    pass(`POST /api/assist/chat → 200`);
                } else {
                    fail('POST /api/assist/chat → invalid response shape');
                }
            } else {
                fail(`POST /api/assist/chat → ${assistChatRes.status}`);
            }

            // Legacy browser pages must not expose the retired web client.
            const loginRes = await httpGet(`${baseProtocol}://127.0.0.1:${SERVER_PORT}/login.html`);
            if (loginRes.status === 301 || loginRes.status === 302) {
                pass(`GET /login.html → ${loginRes.status} (setup redirect)`);
            } else {
                fail(`GET /login.html → ${loginRes.status}`);
            }

        } catch (e) {
            fail(`Server HTTP test failed: ${e.message}`);
        }

        // Test WebSocket
        try {
            const { default: WebSocket } = await import('ws');
            const ws = new WebSocket(`${wsProtocol}://127.0.0.1:${SERVER_PORT}`, sslEnabled ? {
                rejectUnauthorized: false
            } : undefined);
            await new Promise((resolve, reject) => {
                ws.on('open', () => {
                    pass('WebSocket connection → OK');
                    ws.close();
                    resolve();
                });
                ws.on('error', (e) => {
                    fail(`WebSocket connection → ${e.message}`);
                    reject(e);
                });
                setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 3000);
            });
        } catch (e) {
            if (!e.message?.includes('timeout')) {
                fail(`WebSocket test: ${e.message}`);
            }
        }

        // Cleanup
        serverProc.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 500));
    }

    // ─── Results ──────────────────────────────────────────────
    console.log('');
    console.log(`${c.bold}─────────────────────────────────────────────${c.reset}`);
    console.log(`  ${c.green}${c.bold}${passed} passed${c.reset}  ${failed > 0 ? c.red : c.dim}${failed} failed${c.reset}  ${warnings > 0 ? c.yellow : c.dim}${warnings} warnings${c.reset}`);
    console.log(`${c.bold}─────────────────────────────────────────────${c.reset}`);

    if (failed > 0) {
        console.log(`\n  ${c.red}Some tests failed. Fix the issues above and re-run.${c.reset}\n`);
        process.exit(1);
    } else if (warnings > 0) {
        console.log(`\n  ${c.yellow}All tests passed with warnings. Review above.${c.reset}\n`);
    } else {
        console.log(`\n  ${c.green}${c.bold}All tests passed! Ready to go. 🚀${c.reset}\n`);
    }
}

main().catch(err => {
    console.error(`\n${c.red}Fatal test error: ${err.message}${c.reset}\n`);
    process.exit(1);
});
