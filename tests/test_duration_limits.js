"use strict";

const assert = require("assert");
const { checkAiTypeSupport } = require("../src/wink_client");

const config = overrides => ({
  type: 11, content_type: 2, min_time: 1,
  max_time_normal: 60, max_time: 3600, ...overrides,
});
const check = (durationSeconds, isVip, overrides = {}) => checkAiTypeSupport(
  { code: 0, data: [config(overrides)] },
  { type: 11, contentType: "2", strictType: true, durationSeconds, isVip },
);

// A confirmed identity uses only its own account limit, including exact endpoints.
assert.strictEqual(check(60, false).ok, true);
assert.strictEqual(check(60.001, false).ok, false);
assert.match(check(61, false).reason, /普通用户.*60s/);
assert.strictEqual(check(120, true).ok, true);
assert.strictEqual(check(3600, true).ok, true);
assert.strictEqual(check(3600.001, true).ok, false);
assert.match(check(3600.001, true).reason, /会员.*3600s/);

// Unknown membership is not ordinary membership, and truthy values are not VIP.
// Only the shared technical ceiling can be enforced until the server knows the account.
for (const unknown of [undefined, null, "true", "false", "0", "1", 0, 1, {}]) {
  assert.strictEqual(check(61, unknown).ok, true, `unknown ${String(unknown)} must not imply ordinary membership`);
  assert.strictEqual(check(3600, unknown).ok, true);
  const tooLong = check(3600.001, unknown);
  assert.strictEqual(tooLong.ok, false);
  assert.match(tooLong.reason, /3600s/);
  assert.ok(!/普通用户|会员/.test(tooLong.reason), "unknown identity must not be described as a known account tier");
  assert.strictEqual(check(120, unknown, { max_time_normal: 3600, max_time: 60 }).ok, true,
    "non-boolean truthy values must not pick the VIP field even if it is lower");
}
assert.strictEqual(check(120, true, { max_time_normal: 3600, max_time: 60 }).ok, false,
  "confirmed VIP uses max_time rather than the larger of the two account limits");

// Both finite positive limits are required to infer a ceiling for unknown identity.
// A missing, disabled or malformed limit also must not borrow the other account's limit.
const unavailableLimits = [undefined, null, "", "   ", 0, "0", -1, "invalid", NaN, Infinity, -Infinity, true, false, [], [60], {}];
for (const value of unavailableLimits) {
  assert.strictEqual(check(7200, undefined, { max_time_normal: value }).ok, true);
  assert.strictEqual(check(7200, undefined, { max_time: value }).ok, true);
  assert.strictEqual(check(120, true, { max_time: value }).ok, true,
    "missing VIP limit must not fall back to normal 60 seconds");
  assert.strictEqual(check(120, false, { max_time_normal: value, max_time: 60 }).ok, true,
    "missing normal limit must not fall back to the VIP field");
}
const stringLimits = { min_time: "1", max_time_normal: "60", max_time: "3600" };
assert.strictEqual(check(60, false, stringLimits).ok, true);
assert.strictEqual(check(60.001, false, stringLimits).ok, false);
assert.strictEqual(check(3600, undefined, stringLimits).ok, true);
assert.strictEqual(check(3600.001, undefined, stringLimits).ok, false);

// Account handling must not relax common duration constraints or change their units.
for (const identity of [true, false, undefined]) {
  assert.strictEqual(check(1, identity).ok, true);
  assert.match(check(0.999, identity).reason, /下限 1s/);
  assert.strictEqual(check(30, identity, { input_limit: { max_duration_ms: 30000 } }).ok, true);
  assert.match(check(61, identity, { input_limit: { max_duration_ms: 30000 } }).reason, /该功能上限 30s/,
    "common millisecond limit must apply before any account-specific upper bound");
  assert.strictEqual(check(undefined, identity).ok, true, "unknown media duration must still be delegated to the server");
}
assert.strictEqual(checkAiTypeSupport([{
  type: 12, content_type: 1, min_time: 1, max_time_normal: 60, max_time: 3600,
}], { type: 12, contentType: "1", durationSeconds: 7200, isVip: false }).ok, true,
"video account limits must not affect an image input");

console.log("duration limits: explicit VIP/normal/unknown identities, boundaries, absent limits and common media constraints passed");
