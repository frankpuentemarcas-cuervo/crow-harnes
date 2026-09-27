import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { isPrivateLanIPv4 } from '../src/main/mobile-network.ts'

test('only RFC 1918 IPv4 addresses are eligible for the LAN gateway', () => {
  for (const address of ['10.0.0.1', '172.16.0.2', '172.31.255.254', '192.168.1.10']) {
    assert.equal(isPrivateLanIPv4(address), true, address)
  }
  for (const address of ['127.0.0.1', '169.254.1.2', '172.15.0.1', '172.32.0.1', '100.64.0.1', '8.8.8.8', '10..0.1', '192.168.1.256', '10.0.0.1.evil']) {
    assert.equal(isPrivateLanIPv4(address), false, address)
  }
})
