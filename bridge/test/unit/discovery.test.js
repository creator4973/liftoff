import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';

import {
    DISCOVERY_MAGIC,
    startDiscoveryResponder
} from '../../src/discovery.js';

const responders = [];

afterEach(() => {
    while (responders.length) responders.pop().close();
});

function sendDiscovery(port) {
    return new Promise((resolve, reject) => {
        const client = dgram.createSocket('udp4');
        const timer = setTimeout(() => {
            client.close();
            reject(new Error('Discovery response timed out'));
        }, 2000);

        client.once('message', (message) => {
            clearTimeout(timer);
            client.close();
            resolve(JSON.parse(message.toString('utf8')));
        });
        client.once('error', reject);
        client.send(Buffer.from(DISCOVERY_MAGIC), port, '127.0.0.1');
    });
}

describe('LAN discovery responder', () => {
    it('returns bridge metadata without authentication secrets', async () => {
        const port = 24748;
        const responder = startDiscoveryResponder({
            port,
            name: 'Test PC',
            url: 'https://198.51.100.50:4747',
            version: 'test'
        });
        responders.push(responder);

        await new Promise((resolve) => setTimeout(resolve, 50));
        const payload = await sendDiscovery(port);

        expect(payload).toEqual({
            service: 'antigravity-remote',
            name: 'Test PC',
            url: 'https://198.51.100.50:4747',
            version: 'test'
        });
        expect(JSON.stringify(payload)).not.toContain('password');
    });
});
