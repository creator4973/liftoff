// @ts-check
/**
 * Network utilities — IP detection, local request checks, HTTP helpers.
 *
 * @module utils/network
 */

import http from 'http';
import os from 'os';

const VIRTUAL_INTERFACE_PATTERN = /(?:vethernet|hyper-v|vmware|virtualbox|docker|wsl|tailscale|zerotier|loopback|bluetooth|npcap|hamachi)/i;
const WIFI_INTERFACE_PATTERN = /(?:^|[\s_-])(?:wi-?fi|wlan|wireless)(?:[\s_-]|$)/i;
const ETHERNET_INTERFACE_PATTERN = /(?:^|[\s_-])(?:ethernet|eth\d*)(?:[\s_-]|$)/i;

function addressPriority(address) {
    if (address.startsWith('192.168.')) return 0;
    if (address.startsWith('10.')) return 10;
    if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(address)) return 20;
    if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 30;
    return 40;
}

function interfacePriority(name) {
    if (VIRTUAL_INTERFACE_PATTERN.test(name)) return 1000;
    if (WIFI_INTERFACE_PATTERN.test(name)) return 0;
    if (ETHERNET_INTERFACE_PATTERN.test(name)) return 100;
    return 200;
}

export function selectLocalIP(interfaces) {
    /** @type {Array<{address: string, name: string, priority: number}>} */
    const candidates = [];

    for (const name of Object.keys(interfaces || {})) {
        for (const iface of interfaces[name] || []) {
            if (iface.family !== 'IPv4' || iface.internal) continue;
            candidates.push({
                address: iface.address,
                name,
                priority: interfacePriority(name) + addressPriority(iface.address),
            });
        }
    }

    candidates.sort((a, b) =>
        a.priority - b.priority
        || a.name.localeCompare(b.name)
        || a.address.localeCompare(b.address)
    );
    return candidates.length > 0 ? candidates[0].address : 'localhost';
}

/**
 * Get local IP address for mobile access.
 * Prefers real network IPs (192.168.x.x, 10.x.x.x) over virtual adapters (172.x.x.x from WSL/Docker).
 * @returns {string} Best local IP address or 'localhost'
 */
export function getLocalIP() {
    return selectLocalIP(os.networkInterfaces());
}

/**
 * Check if a request originates from the local network (same Wi-Fi).
 * Returns false for requests coming through external proxies/tunnels.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function isLocalRequest(req) {
    // Check for proxy headers (Cloudflare, ngrok, etc.)
    if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['x-real-ip']) {
        return false;
    }

    const ip = req.ip || req.socket.remoteAddress || '';

    return ip === '127.0.0.1' ||
        ip === '::1' ||
        ip === '::ffff:127.0.0.1' ||
        ip.startsWith('192.168.') ||
        ip.startsWith('10.') ||
        ip.startsWith('172.16.') || ip.startsWith('172.17.') ||
        ip.startsWith('172.18.') || ip.startsWith('172.19.') ||
        ip.startsWith('172.2') || ip.startsWith('172.3') ||
        ip.startsWith('::ffff:192.168.') ||
        ip.startsWith('::ffff:10.');
}

/**
 * HTTP GET JSON — lightweight helper without external dependencies.
 *
 * @param {string} url - URL to fetch
 * @returns {Promise<any>} Parsed JSON response
 */
export function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}
