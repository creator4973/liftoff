import dgram from 'node:dgram';

export const DISCOVERY_PORT = 4748;
export const DISCOVERY_MAGIC = 'ANTIGRAVITY_REMOTE_DISCOVER_V1';

/**
 * Starts a LAN-only UDP responder used by the native app to find the bridge.
 * The response deliberately contains no password or authentication token.
 * @param {{url: string, version: string, name?: string, port?: number}} options
 */
export function startDiscoveryResponder(options) {
    const port = Number(options.port || DISCOVERY_PORT);
    const socket = dgram.createSocket('udp4');
    let closed = false;

    socket.on('error', (error) => {
        console.warn(`LAN discovery unavailable: ${error.message}`);
        if (!closed) {
            closed = true;
            try { socket.close(); } catch (_) { }
        }
    });

    socket.on('message', (message, remote) => {
        if (message.toString('utf8').trim() !== DISCOVERY_MAGIC) return;
        const payload = Buffer.from(JSON.stringify({
            service: 'antigravity-remote',
        name: options.name || 'LiftOff',
            url: options.url,
            version: options.version
        }));
        socket.send(payload, remote.port, remote.address, (error) => {
            if (error) console.warn(`LAN discovery response failed: ${error.message}`);
        });
    });

    socket.bind(port, '0.0.0.0', () => {
        socket.setBroadcast(true);
        console.log(`  LAN discovery listening on UDP ${port}`);
    });

    return {
        close() {
            if (closed) return;
            closed = true;
            try { socket.close(); } catch (_) { }
        }
    };
}
