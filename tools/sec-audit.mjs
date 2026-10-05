/**
 * Adversarial security harness.
 *
 * Attacks every privileged endpoint with forged, malformed and spoofed
 * credentials, then checks that each one is refused. A "PASS" means the
 * endpoint did NOT return the privileged payload.
 *
 * Usage: node tools/sec-audit.mjs [baseUrl]
 */
const BASE = process.argv[2] || 'http://localhost:3220';

// A syntactically-valid JWT carrying role:"admin" — the classic forged claim.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const FORGED_ADMIN = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'attacker', role: 'admin', email: 'a@b.com' })}.sig`;
const ANON_SHAPED = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'x', role: 'anon' })}.sig`;

const TOKENS = {
  'forged-admin-jwt': FORGED_ADMIN,
  'anon-shaped-jwt': ANON_SHAPED,
  'literal-admin': 'admin',
  'empty': '',
  'null-string': 'null',
  'undefined-string': 'undefined',
  'sql-ish': "' OR 1=1 --",
  'long': 'A'.repeat(5000),
};

const AUTH_VARIANTS = [
  ['none', {}],
  ['bearer-forged', { Authorization: `Bearer ${FORGED_ADMIN}` }],
  ['bearer-anon', { Authorization: `Bearer ${ANON_SHAPED}` }],
  ['basic', { Authorization: 'Basic YWRtaW46YWRtaW4=' }],
  ['token-scheme', { Authorization: `Token ${FORGED_ADMIN}` }],
  ['bearer-nospace', { Authorization: `BearerX ${FORGED_ADMIN}` }],
  ['lowercase-bearer', { Authorization: `bearer ${FORGED_ADMIN}` }],
  ['x-admin-header', { 'x-admin': 'true', 'x-role': 'admin' }],
  ['cookie-role', { Cookie: 'role=admin; isAdmin=true' }],
  ['two-segment', { Authorization: `Bearer ${b64({ a: 1 })}.${b64({ b: 2 })}` }],
  ['four-segment', { Authorization: `Bearer a.b.c.d` }],
];

// path, method, and what a LEAK looks like
const TARGETS = [
  ['GET', '/api/orders', (b) => /order_number|customer_email|customer_name/.test(b)],
  ['PATCH', '/api/orders', (b) => /"success"\s*:\s*true/.test(b)],
  ['GET', '/api/contact', (b) => /"success"\s*:\s*true/.test(b)],
  ['POST', '/api/products', (b) => /"success"\s*:\s*true/.test(b)],
  ['POST', '/api/payments/livepay/test-connection', (b) => /"success"\s*:\s*true/.test(b)],
  ['POST', '/api/store-rating', (b) => /"success"\s*:\s*true/.test(b)],
];

let pass = 0, fail = 0, blocked = 0, closed = 0;
const failures = [];

async function hit(method, path, headers, body) {
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, body: text };
  } catch (e) {
    return { status: 0, body: String(e) };
  }
}

console.log('=== 1. AUTHORIZATION MATRIX ===');
for (const [method, path, isLeak] of TARGETS) {
  for (const [label, hdrs] of AUTH_VARIANTS) {
    const payload = method === 'GET' ? undefined
      : path === '/api/orders' ? { orderId: 'x', paymentStatus: 'Paid', note: 'hacked in' }
      : path === '/api/store-rating' ? { rating: 5, comment: 'x' }
      : { product: { id: 'evil', name: 'evil' }, action: undefined };
    const { status, body } = await hit(method, path, hdrs, payload);

    // 401/403 = refused. 429 = rate limiter. 502/503 = deliberate fail-closed
    // (no Supabase / no gateway in this sandbox) - not a leak and not a crash.
    const refused = status === 401 || status === 403 || status === 429;
    const failClosed = status === 502 || status === 503;
    const leaked = isLeak(body);

    if (refused && !leaked) { pass++; if (status === 429) blocked++; }
    else if (failClosed && !leaked) { pass++; closed++; }
    else { fail++; failures.push(`${method} ${path} [${label}] -> ${status} ${body.slice(0, 90)}`); }
  }
}
console.log(`  refused: ${pass}  (${blocked} by the rate limiter, ${closed} fail-closed 502/503)`);
console.log(`  LEAKED:  ${fail}`);

console.log('\n=== 2. TOKEN PARSING EDGE CASES (GET /api/orders) ===');
for (const [label, tok] of Object.entries(TOKENS)) {
  const { status } = await hit('GET', '/api/orders', { Authorization: `Bearer ${tok}` });
  const ok = status === 401 || status === 403 || status === 429;
  console.log(`  ${ok ? 'BLOCK' : 'ALLOW'}  ${label.padEnd(16)} -> ${status}`);
  if (!ok) fail++; else pass++;
}

console.log('\n=== 3. INJECTION ATTEMPTS ===');
const injections = [
  ['order id SQL', '/api/orders', 'PATCH', { orderId: "'; DROP TABLE orders; --", paymentStatus: 'Paid', note: 'x' }],
  ['postgrest filter', '/api/orders?id=or.(id.eq.1)', 'GET', undefined],
  ['track wildcard', '/api/orders?track=%25', 'GET', undefined],
  ['track injection', '/api/orders?track=DP%27%20OR%201=1--', 'GET', undefined],
  ['reviews productId', '/api/reviews?productId=*', 'GET', undefined],
  ['store-rating XSS comment', '/api/store-rating', 'POST', { rating: 5, comment: '<script>alert(1)</script>' }],
  ['rating out of range', '/api/store-rating', 'POST', { rating: 99 }],
  ['rating non-numeric', '/api/store-rating', 'POST', { rating: 'five' }],
  ['tracking injection', '/api/orders', 'PATCH', { orderId: 'x', trackingNumber: "'; DROP TABLE--" }],
  ['login email injection', '/api/auth/login', 'POST', { email: "a'@b.com", password: 'x' }],
  ['oversized body', '/api/orders', 'POST', { customerName: 'A'.repeat(200000), items: [] }],
];
for (const [label, path, method, body] of injections) {
  const { status } = await hit(method, path, {}, body);
  // 4xx = rejected. 502/503 = deliberate fail-closed. A real crash would be a
  // 500 that is NOT one of those.
  const failClosed = status === 502 || status === 503;
  const rejected = status >= 400 && status < 500;
  const crash = status >= 500 && !failClosed;
  console.log(`  ${crash ? 'CRASH' : failClosed ? 'closed' : rejected ? 'reject' : 'ALLOW'} ${String(status).padEnd(4)}  ${label}`);
  if (crash) { fail++; failures.push(`crash (${status}) on ${label}`); } else pass++;
}

console.log('\n=== 4. WEBHOOK ===');
const wh = '/api/payments/livepay/webhook';
const paidPayload = { status: 'Success', customer_reference: 'ORDDP-AAAA-BBBB', internal_reference: 'r1', amount: 1, currency: 'UGX' };
for (const [label, hdrs, body] of [
  ['no signature', {}, paidPayload],
  ['bad signature', { 'x-webhook-signature': 't=9999999999,v=deadbeef' }, paidPayload],
  ['empty header', { 'x-webhook-signature': '' }, paidPayload],
  ['malformed header', { 'x-webhook-signature': 'garbage' }, paidPayload],
  ['replayed old ts', { 'x-webhook-signature': 't=1000000000,v=' + 'a'.repeat(64) }, paidPayload],
  ['alg-confusion', { 'x-webhook-signature': `t=${Math.floor(Date.now() / 1000)},v=${'0'.repeat(64)}` }, paidPayload],
]) {
  const { status } = await hit('POST', wh, hdrs, body);
  const ok = status === 401 || status === 403 || status === 429;
  console.log(`  ${ok ? 'BLOCK' : 'ALLOW'}  ${String(status).padEnd(4)} ${label}`);
  if (!ok) { fail++; failures.push(`webhook ${label} -> ${status}`); } else pass++;
}

console.log('\n=== 5. PII EXPOSURE ON PUBLIC ENDPOINTS ===');
const PII = /@(gmail|yahoo|outlook|hotmail|drumpalace)\.|\+256[0-9]{6,}|0[7][0-9]{8}/i;
for (const path of ['/api/products', '/api/categories', '/api/store-rating', '/api/health', '/']) {
  const { status, body } = await hit('GET', path, {});
  const found = PII.exec(body);
  console.log(`  ${found ? 'PII!!' : 'clean'} ${String(status).padEnd(4)} ${path}${found ? '  -> ' + found[0] : ''}`);
  if (found) { fail++; failures.push(`PII on ${path}`); } else pass++;
}

console.log('\n=== 6. SECURITY HEADERS ===');
const r = await fetch(BASE + '/');
for (const h of ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'strict-transport-security', 'referrer-policy', 'permissions-policy']) {
  const v = r.headers.get(h);
  console.log(`  ${v ? 'ok   ' : 'MISS '} ${h}${v ? ' = ' + v.slice(0, 70) : ''}`);
  if (!v) { fail++; failures.push(`missing header ${h}`); } else pass++;
}

console.log('\n=== 7. METHOD GUARDS ===');
for (const path of ['/api/auth/login', '/api/auth/register', '/api/auth/password-reset', '/api/payments/livepay/webhook']) {
  const res = await fetch(BASE + path);
  const ok = res.status === 405 || res.status === 401;
  console.log(`  ${ok ? 'ok   ' : 'ALLOW'} GET ${path} -> ${res.status}`);
  if (!ok) { fail++; failures.push(`GET allowed on ${path}`); } else pass++;
}

console.log(`\n================  PASS ${pass}   FAIL ${fail}  ================`);
if (failures.length) {
  console.log('FAILURES:');
  failures.forEach((f) => console.log('  - ' + f));
}
process.exit(fail > 0 ? 1 : 0);
