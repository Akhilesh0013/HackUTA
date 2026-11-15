import assert from 'node:assert/strict';
import test from 'node:test';
import { containsPII, redactText } from '../src/pii.mjs';

test('redacts secrets, emails, phones, serials, MACs, public IPs', () => {
  const cases = [
    ['the wifi password is hunter2pass', 'secret'],
    ['email me at jane.doe@example.com', 'email'],
    ['call 817-555-0142', 'phone'],
    ['S/N: ABC123456789', 'serial'],
    ['MAC 00:1A:2B:3C:4D:5E', 'mac'],
    ['WAN IP 73.44.12.9', 'public_ip'],
    ['I live at 1200 Oak Hollow Street', 'address'],
  ];
  for (const [text, type] of cases) {
    const r = redactText(text);
    assert.ok(r.found.includes(type), `${type} not found in "${text}" → ${JSON.stringify(r)}`);
    assert.ok(r.text.includes(`[REDACTED:${type}]`));
  }
});

test('keeps useful technical text intact', () => {
  for (const t of [
    'Plug the 8-pin CPU cable in',
    'The pin is bent on the socket',
    'Open 192.168.1.1 in a browser',
    'Monitor model P2422H on HDMI 1',
    'Choose the 2.4 GHz network instead',
  ]) {
    assert.equal(containsPII(t), false, t);
  }
});
