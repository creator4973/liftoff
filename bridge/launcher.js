#!/usr/bin/env node
// @ts-check
/**
 * LiftOff Antigravity Bridge - Node.js Launcher
 * Replaces launcher.py with pure Node.js implementation.
 * Supports local (Wi-Fi) and web (Cloudflare, Pinggy, or ngrok) modes.
 *
 * @module launcher
 */
import 'dotenv/config';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import http from 'http';
import https from 'https';
import { getLocalIP } from './src/utils/network.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);

/**
 * @param {string} flag
 * @param {string} fallback
 * @returns {string}
 */
function readArg(flag, fallback) {
    const index = args.indexOf(flag);
    if (index === -1) return fallback;
    return args[index + 1] || fallback;
}

/** @type {'local' | 'web'} */
const mode = /** @type {'local' | 'web'} */ (readArg('--mode', 'local'));
const requestedTunnelProvider = String(
    readArg('--provider', process.env.TUNNEL_PROVIDER || 'cloudflare')
).toLowerCase();

// Colors for terminal output
const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    bgBlue: '\x1b[44m',
    white: '\x1b[37m',
};

/** Print the startup banner. */
function banner() {
    console.log('');
    console.log(`${c.magenta}${c.bold}  ╔══════════════════════════════════════════╗${c.reset}`);
    console.log(`${c.magenta}${c.bold}  ║   LiftOff Antigravity Bridge              ║${c.reset}`);
    console.log(`${c.magenta}${c.bold}  ║   Mobile Remote Control for AI Sessions  ║${c.reset}`);
    console.log(`${c.magenta}${c.bold}  ╚══════════════════════════════════════════╝${c.reset}`);
    if (mode === 'web') {
        console.log(`${c.dim}  Mode: 🌐 Web (${requestedTunnelProvider} preferred)${c.reset}`);
    } else {
        console.log(`${c.dim}  Mode: 📶 Local (Wi-Fi)${c.reset}`);
    }
    console.log('');
}

/**
 * Display a QR code in the terminal for easy phone access.
 * @param {string} url
 * @returns {Promise<void>}
 */
async function showQRCode(url) {
    try {
        const { default: qrcode } = await import('qrcode-terminal');
        console.log(`${c.cyan}${c.bold}  Scan this QR code on your phone:${c.reset}\n`);
        qrcode.generate(url, { small: true }, (qr) => {
            qr.split('\n').forEach(line => console.log('    ' + line));
        });
        console.log('');
    } catch (/** @type {any} */ e) {
        console.log(`${c.yellow}  ⚠ qrcode-terminal not available. Install with: npm install qrcode-terminal${c.reset}`);
        console.log(`${c.dim}  (QR code display is optional — you can still use the URL below)${c.reset}\n`);
    }
}

/**
 * Start an ngrok tunnel for public web access.
 * @param {number} port
 * @returns {Promise<string>} Public URL
 */
async function startNgrok(port) {
    const token = process.env.NGROK_AUTHTOKEN;
    if (!token) {
        console.error(`${c.red}  ✗ NGROK_AUTHTOKEN not set in .env file${c.reset}`);
        console.log(`${c.dim}  Set NGROK_AUTHTOKEN in your .env file to use web mode.${c.reset}`);
        process.exit(1);
    }

    try {
        const ngrok = await import('@ngrok/ngrok');
        const listener = await ngrok.default.connect({ addr: port, authtoken: token });
        return listener.url();
    } catch (/** @type {any} */ e) {
        console.error(`${c.red}  ✗ ngrok failed: ${e.message}${c.reset}`);
        console.log(`${c.dim}  Install ngrok with: npm install @ngrok/ngrok${c.reset}`);
        process.exit(1);
    }
}

/**
 * Send a JSON request to the local server, allowing self-signed HTTPS.
 *
 * @param {number} port
 * @param {'http' | 'https'} protocol
 * @param {string} path
 * @param {unknown} body
 * @returns {Promise<{statusCode: number, payload: any}>}
 */
function requestLocalJson(port, protocol, path, body) {
    const transport = protocol === 'https' ? https : http;
    const payload = JSON.stringify(body);

    return new Promise((resolve, reject) => {
        const req = transport.request({
            host: '127.0.0.1',
            port,
            path,
            method: 'POST',
            rejectUnauthorized: false,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'ngrok-skip-browser-warning': 'true'
            }
        }, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                raw += chunk;
            });
            res.on('end', () => {
                try {
                    resolve({
                        statusCode: res.statusCode || 0,
                        payload: raw ? JSON.parse(raw) : {}
                    });
                } catch (error) {
                    reject(error);
                }
            });
        });

        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

/**
 * Ask the local server to start a managed tunnel provider.
 *
 * @param {number} port
 * @param {'cloudflare' | 'pinggy'} provider
 * @returns {Promise<string>}
 */
async function startManagedTunnel(port, provider) {
    const attempts = ['https', 'http'];

    for (const protocol of attempts) {
        try {
            const { statusCode, payload } = await requestLocalJson(
                port,
                /** @type {'http' | 'https'} */ (protocol),
                '/api/admin/tunnel/start',
                { provider }
            );

            if (statusCode >= 200 && statusCode < 300 && payload.url) {
                return payload.url;
            }

            throw new Error(payload.error || `${provider} tunnel unavailable`);
        } catch (error) {
            if (protocol === attempts[attempts.length - 1]) {
                throw error;
            }
        }
    }

    throw new Error(`${provider} tunnel unavailable`);
}

/**
 * @returns {Array<'cloudflare' | 'pinggy' | 'ngrok'>}
 */
function getTunnelCandidates() {
    /** @type {Array<'cloudflare' | 'pinggy' | 'ngrok'>} */
    const ordered = [];
    /** @type {Array<'cloudflare' | 'pinggy' | 'ngrok'>} */
    const defaults = ['cloudflare', 'pinggy', 'ngrok'];

    if (requestedTunnelProvider === 'cloudflare' || requestedTunnelProvider === 'pinggy' || requestedTunnelProvider === 'ngrok') {
        ordered.push(/** @type {'cloudflare' | 'pinggy' | 'ngrok'} */ (requestedTunnelProvider));
    }

    defaults.forEach((provider) => {
        if (!ordered.includes(provider)) {
            ordered.push(provider);
        }
    });

    return ordered;
}

/**
 * Main entry point.
 * @returns {Promise<void>}
 */
async function main() {
    banner();

    const port = process.env.PORT || 4747;
    const localIP = getLocalIP();

    // Ensure .env exists
    const envPath = join(__dirname, '.env');
    const examplePath = join(__dirname, '.env.example');
    if (!fs.existsSync(envPath) && fs.existsSync(examplePath)) {
        fs.copyFileSync(examplePath, envPath);
        console.log(`${c.yellow}  ℹ Created .env from .env.example${c.reset}\n`);
    }

    // Start the Node.js server
    console.log(`${c.blue}  ▶ Starting server...${c.reset}`);
    const server = spawn('node', [join(__dirname, 'src', 'server.js')], {
        cwd: __dirname,
        stdio: 'inherit',
        env: { ...process.env }
    });

    // Wait for server to be ready
    await new Promise(r => setTimeout(r, 2000));

    if (mode === 'web') {
        let publicUrl = '';
        const tunnelCandidates = getTunnelCandidates();

        for (const provider of tunnelCandidates) {
            try {
                if (provider === 'ngrok') {
                    console.log(`${c.blue}  ▶ Starting ngrok tunnel...${c.reset}`);
                    publicUrl = await startNgrok(parseInt(String(port)));
                } else {
                    console.log(`${c.blue}  ▶ Starting ${provider} tunnel...${c.reset}`);
                    publicUrl = await startManagedTunnel(parseInt(String(port)), provider);
                }
                break;
            } catch (error) {
                console.log(`${c.yellow}  ⚠ ${provider} unavailable: ${error.message}${c.reset}`);
            }
        }

        if (!publicUrl) {
            throw new Error('No tunnel provider became available');
        }

        console.log('');
        console.log(`${c.green}${c.bold}  ✓ Web Access Ready!${c.reset}`);
        console.log(`${c.cyan}  → ${publicUrl}${c.reset}`);
        console.log('');
        await showQRCode(publicUrl);
    } else {
        const localUrl = `http://${localIP}:${port}`;
        console.log('');
        console.log(`${c.green}${c.bold}  ✓ Local Access Ready!${c.reset}`);
        console.log(`${c.cyan}  → ${localUrl}${c.reset}`);
        console.log(`${c.dim}  (Phone must be on the same Wi-Fi network)${c.reset}`);
        console.log('');
        await showQRCode(localUrl);
    }

    console.log(`${c.dim}  Press Ctrl+C to stop${c.reset}\n`);

    // Handle graceful shutdown
    const cleanup = () => {
        server.kill();
        process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}

main().catch(err => {
    console.error(`${c.red}  ✗ Fatal: ${err.message}${c.reset}`);
    process.exit(1);
});
