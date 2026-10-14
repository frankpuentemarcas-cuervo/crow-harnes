import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
const compose = readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8')
const nginx = readFileSync(new URL('../deploy/nginx-crow-frabubu.location.conf', import.meta.url), 'utf8')

test('relay Compose is locked to Node 22 and installs production dependencies from the lockfile once', () => {
  assert.match(compose, /image:\s*node:22-alpine/)
  assert.match(compose, /"npm",\s*"ci",\s*"--omit=dev",\s*"--ignore-scripts"/)
  assert.match(compose, /condition:\s*service_completed_successfully/)
  assert.match(compose, /MAX_ROUTES:\s*["']?2["']?\s*\n\s*MAX_DEVICE_STREAMS_PER_ROUTE:\s*["']?4/)
  assert.match(compose, /cpus:\s*["']?0\.25["']?\s*\n\s*mem_limit:\s*128m\s*\n\s*pids_limit:\s*32/)
  assert.match(compose, /mobile-relay-node-modules:/)
  assert.equal(lock.lockfileVersion, 3)
  assert.equal(lock.packages[''].dependencies.ws, packageJson.dependencies.ws)
  assert.match(lock.packages['node_modules/ws'].version, /^8\./)
  assert.match(lock.packages['node_modules/ws'].integrity, /^sha512-/)
})

test('relay runtime has no host port, an isolated fixed-IP network and strict least-privilege limits', () => {
  assert.doesNotMatch(compose, /\n\s+ports:\s*\n/)
  assert.match(compose, /internal:\s*true/)
  assert.match(compose, /subnet:\s*172\.30\.254\.0\/28/)
  assert.match(compose, /ipv4_address:\s*172\.30\.254\.2/)
  assert.match(compose, /user:\s*["']?10001:10001/)
  assert.match(compose, /read_only:\s*true/)
  assert.match(compose, /cpus:\s*["']?0\.25/)
  assert.match(compose, /mem_limit:\s*128m/)
  assert.match(compose, /pids_limit:\s*32/)
  assert.match(compose, /cap_drop:\s*\n\s*-\s*ALL/)
  assert.match(compose, /no-new-privileges:true/)
  assert.match(compose, /mobile-relay-node-modules:\/app\/node_modules:ro/)
})

test('Nginx snippet upgrades only the exact tunnel path and disables access logging there', () => {
  assert.match(nginx, /location\s*=\s*\/v1\/tunnel\s*\{/)
  assert.match(nginx, /proxy_pass\s+http:\/\/172\.30\.254\.2:8080\s*;/)
  assert.match(nginx, /proxy_http_version\s+1\.1/)
  assert.match(nginx, /proxy_set_header\s+Upgrade\s+\$http_upgrade/)
  assert.match(nginx, /proxy_set_header\s+Connection\s+"upgrade"/)
  assert.match(nginx, /proxy_buffering\s+off/)
  assert.match(nginx, /proxy_request_buffering\s+off/)
  assert.match(nginx, /access_log\s+off/)
  assert.doesNotMatch(nginx, /listen\s+|server_name\s+|ssl_certificate\s+/)
})
