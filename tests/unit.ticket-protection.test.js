'use strict';

const { SlidingWindowRateLimiter, DuplicateTicketGuard } = require('../src/utils/ticket-protection');

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

const WINDOW_MS = 10 * 60 * 1000;
const limiter = new SlidingWindowRateLimiter(2, WINDOW_MS);
const identities = ['email:user@plnbatam.com', 'wa:628123456789'];

assert('first ticket reserves both identities', limiter.reserve(identities, 1000).allowed);
assert('second ticket reserves both identities', limiter.reserve(identities, 2000).allowed);
assert('limit applies to email and WA', !limiter.reserve(identities, 3000).allowed);
assert('failed submission can roll back its reservation', (() => {
  const attempt = limiter.reserve(['email:other@plnbatam.com', 'wa:628000000000'], 4000);
  limiter.rollback(attempt.reservation);
  return limiter.reserve(['email:other@plnbatam.com', 'wa:628000000000'], 5000).allowed;
})());
assert('expired events leave the sliding window', limiter.reserve(identities, WINDOW_MS + 1001).allowed);

const duplicateGuard = new DuplicateTicketGuard(WINDOW_MS);
const first = duplicateGuard.reserve('same-ticket', 1000);
assert('same content cannot be submitted concurrently', duplicateGuard.reserve('same-ticket', 1001) === null);
duplicateGuard.commit(first, 1000);
assert('committed content is blocked during duplicate window', duplicateGuard.reserve('same-ticket', 2000) === null);
assert('different content is allowed', duplicateGuard.reserve('different-ticket', 2000) !== null);
assert('content is allowed again after 10 minutes', duplicateGuard.reserve('same-ticket', WINDOW_MS + 1001) !== null);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;