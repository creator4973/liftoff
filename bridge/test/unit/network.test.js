import { describe, expect, it } from 'vitest';
import { selectLocalIP } from '../../src/utils/network.js';

function ipv4(address, internal = false) {
  return { address, family: 'IPv4', internal };
}

describe('local network address selection', () => {
  it('prefers the active Wi-Fi address over a virtual 192.168 adapter', () => {
    expect(
      selectLocalIP({
        'VMware Network Adapter VMnet8': [ipv4('198.51.100.224')],
        'Wi-Fi': [ipv4('198.51.100.16')],
      })
    ).toBe('198.51.100.16');
  });

  it('prefers physical Ethernet over virtual and tunnel adapters', () => {
    expect(
      selectLocalIP({
        'vEthernet (WSL)': [ipv4('198.51.100.28')],
        Tailscale: [ipv4('203.0.113.120')],
        Ethernet: [ipv4('198.51.100.25')],
      })
    ).toBe('198.51.100.25');
  });

  it('ignores loopback and returns localhost when no LAN address exists', () => {
    expect(selectLocalIP({ Loopback: [ipv4('127.0.0.1', true)] }))
      .toBe('localhost');
  });
});
