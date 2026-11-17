/**
 * The prepaid phone balance as the relay reports it to the install (#109, v0.1.47).
 */
import { describe, expect, test } from "bun:test";
import { phoneBalanceFrom } from "../src/phone-line/service";

const now = new Date("2026-11-17T12:00:00.000Z");
const good = {
  type: "phone.balance",
  balanceMils: 7960,
  state: "low",
  minutesLeftAtLeast: 57.9,
  topUpUrl: "https://blackark.uk/checkin/buy/?topup=1&customer=demo-phone",
};

describe("the phone balance from the relay (v0.1.47)", () => {
  test("reads the balance, the state and the top-up page", () => {
    expect(phoneBalanceFrom(good, now)).toEqual({
      balanceMils: 7960,
      state: "low",
      minutesLeftAtLeast: 57,
      topUpUrl: "https://blackark.uk/checkin/buy/?topup=1&customer=demo-phone",
      receivedAt: "2026-11-17T12:00:00.000Z",
    });
  });

  test("refuses an unknown state, a fractional amount or a top-up page that is not https", () => {
    expect(phoneBalanceFrom({ ...good, state: "free" }, now)).toBeNull();
    expect(phoneBalanceFrom({ ...good, balanceMils: 1.5 }, now)).toBeNull();
    expect(
      phoneBalanceFrom({ ...good, topUpUrl: "http://blackark.uk/buy" }, now),
    ).toBeNull();
    expect(
      phoneBalanceFrom({ ...good, topUpUrl: "javascript:alert(1)" }, now),
    ).toBeNull();
  });
});
