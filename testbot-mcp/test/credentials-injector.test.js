const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildLoginCandidates,
  buildSuccessLocators,
  normalizeRoleLabel,
  shouldAcceptLoginVerification,
  stateFileFor,
  summarizeAuthStateEvidence,
} = require('../src/credentials-injector');

test('credential injector probes common login routes when authFlow is unknown', () => {
  assert.deepEqual(
    buildLoginCandidates('http://localhost:3001'),
    [
      'http://localhost:3001/',
      'http://localhost:3001/login',
      'http://localhost:3001/signin',
      'http://localhost:3001/sign-in',
      'http://localhost:3001/auth/login',
      'http://localhost:3001/auth/signin',
      'http://localhost:3001/auth/sign-in',
      'http://localhost:3001/users/sign_in',
      'http://localhost:3001/account/login',
    ],
  );
});

test('credential injector honors explicit authFlow loginUrl before fallbacks', () => {
  assert.deepEqual(
    buildLoginCandidates('http://localhost:3001', { loginUrl: '/admin/login' }),
    ['http://localhost:3001/admin/login'],
  );
});

test('credential injector does not trust register pages as login authFlow', () => {
  assert.deepEqual(
    buildLoginCandidates('http://localhost:3001', {
      loginUrl: '/register',
      intent: 'register',
      credentialFields: { username: 'input[name="email"]', password: 'input[type="password"]' },
    }),
    [
      'http://localhost:3001/',
      'http://localhost:3001/login',
      'http://localhost:3001/signin',
      'http://localhost:3001/sign-in',
      'http://localhost:3001/auth/login',
      'http://localhost:3001/auth/signin',
      'http://localhost:3001/auth/sign-in',
      'http://localhost:3001/users/sign_in',
      'http://localhost:3001/account/login',
    ],
  );
});

test('credential injector normalizes role aliases for storageState names', () => {
  assert.equal(normalizeRoleLabel('Administrator'), 'admin');
  assert.equal(normalizeRoleLabel('super_admin'), 'admin');
  assert.equal(normalizeRoleLabel('Authenticated'), 'user');
  assert.equal(normalizeRoleLabel('QA Admin'), 'qa_admin');
  assert.match(stateFileFor('/tmp/app', 'Administrator'), /auth-state-admin\.json$/);
});

test('credential injector recognizes common auth storage evidence', () => {
  assert.deepEqual(
    summarizeAuthStateEvidence({
      cookies: [{ name: '__Secure-next-auth.session-token', value: 'abc' }],
      storageKeys: [],
    }),
    {
      hasAuthState: true,
      cookieName: '__Secure-next-auth.session-token',
      storageKey: null,
    },
  );

  assert.deepEqual(
    summarizeAuthStateEvidence({
      cookies: [{ name: '_ga', value: 'analytics' }],
      storageKeys: ['sb-otanlyuasavknmdnvzxz-auth-token'],
    }),
    {
      hasAuthState: true,
      cookieName: null,
      storageKey: 'sb-otanlyuasavknmdnvzxz-auth-token',
    },
  );

  assert.deepEqual(
    summarizeAuthStateEvidence({
      cookies: [{ name: 'connect.sid', value: 'signed-session' }],
      storageKeys: [],
    }),
    {
      hasAuthState: true,
      cookieName: 'connect.sid',
      storageKey: null,
    },
  );

  assert.deepEqual(
    summarizeAuthStateEvidence({
      cookies: [{ name: 'csrf_token', value: 'csrf' }],
      storageKeys: ['currentUser'],
    }),
    {
      hasAuthState: true,
      cookieName: null,
      storageKey: 'currentUser',
    },
  );
});

test('credential injector treats discovered successIndicator as advisory', () => {
  assert.equal(shouldAcceptLoginVerification({
    urlChanged: true,
    successIndicatorVisible: false,
    authStateEvidence: { hasAuthState: false },
    failureVisible: false,
  }), true);

  assert.equal(shouldAcceptLoginVerification({
    urlChanged: false,
    successIndicatorVisible: false,
    authStateEvidence: { hasAuthState: true, storageKey: 'sb-app-auth-token' },
    failureVisible: false,
  }), true);

  assert.equal(shouldAcceptLoginVerification({
    urlChanged: true,
    successIndicatorVisible: true,
    authStateEvidence: { hasAuthState: true },
    failureVisible: true,
  }), false);
});

test('credential injector accepts login when form fields disappear with no error (SPA same-URL flow)', () => {
  // SPA that stays on "/" after login: URL unchanged, no auth-named cookie,
  // no visible success text — but the login form is gone.
  assert.equal(shouldAcceptLoginVerification({
    urlChanged: false,
    successIndicatorVisible: false,
    authStateEvidence: { hasAuthState: false },
    failureVisible: false,
    formGone: true,
  }), true, 'form gone without error should accept');

  // failureVisible overrides even when form is gone
  assert.equal(shouldAcceptLoginVerification({
    urlChanged: false,
    successIndicatorVisible: false,
    authStateEvidence: { hasAuthState: false },
    failureVisible: true,
    formGone: true,
  }), false, 'failure text must still block acceptance');

  // formGone=false with no other signals → still reject
  assert.equal(shouldAcceptLoginVerification({
    urlChanged: false,
    successIndicatorVisible: false,
    authStateEvidence: { hasAuthState: false },
    failureVisible: false,
    formGone: false,
  }), false, 'no signals at all should reject');
});

test('credential injector checks durable logged-in markers and username text', () => {
  const locators = buildSuccessLocators(
    { successIndicator: 'nav >> text=Signed in' },
    { username: 'customer@example.test' },
  );

  assert.ok(locators.includes('nav >> text=Signed in'));
  assert.ok(locators.includes('text=/log\\s*out/i'));
  assert.ok(locators.includes('text=\"customer@example.test\"'));
});
