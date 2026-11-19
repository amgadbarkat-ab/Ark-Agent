import { describe, expect, test } from "bun:test";
import { recentLogs, scrubLine } from "../src/support/scrub";

describe("scrubbed recent logs for Help & support (#149)", () => {
  test("a JSON line keeps only what happened, never free text", () => {
    expect(
      scrubLine(
        JSON.stringify({
          type: "trial-check-in-failed",
          status: 503,
          error:
            'duplicate key value violates unique constraint: email "maria@shop.example"',
          customerName: "Demo Shop",
          message: "Γεια σας, ο λογαριασμός μου",
        }),
      ),
    ).toBe('{"type":"trial-check-in-failed","status":503}');
  });

  test("a text line loses emails, addresses' paths, IPs, numbers, ids, keys, codes and quoted text", () => {
    const line = [
      "mailbox sign-in refused for maria@shop.example",
      "at https://mail.example.com/owa/?user=maria&token=abc",
      "from 192.168.1.20 and 2001:db8:0:0:0:0:2:1",
      "calling +30 210 123 4567",
      "install 6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
      "key sk-example-00000000000000000000000000",
      "code ARK1-eyJ2IjoxfQ.c2lnbmF0dXJl",
      "password=hunter2-hunter2",
      'said "please call me back"',
      "in /Users/maria/Library/Logs and C:\\Users\\Maria\\AppData",
    ].join(" ");
    const out = scrubLine(line);
    for (const leaked of [
      "maria@",
      "/owa",
      "token=abc",
      "192.168",
      "2001:db8",
      "210 123",
      "6f1c2a3b",
      "sk-example",
      "ARK1-",
      "hunter2",
      "call me back",
      "/Users/maria",
      "\\Maria",
    ]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain("mailbox sign-in refused for [email]");
    expect(out).toContain("https://mail.example.com");
  });

  test("keeps the last 200 lines of the last 24 hours, scrubbed when caught", () => {
    const logs = recentLogs();
    const t0 = Date.parse("2026-11-18T10:00:00Z");
    logs.record(
      "error",
      ["old", new Error("from yesterday")],
      t0 - 25 * 3_600_000,
    );
    for (let i = 0; i < 250; i++)
      logs.record("warn", [`line ${i} for x@y.example`], t0 + i);
    const lines = logs.lines(t0 + 1000, 500);
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe("2026-11-18T10:00:00.050Z warn line 50 for [email]");
    expect(lines.join("\n")).not.toContain("x@y.example");
    expect(logs.lines(t0 + 1000)).toHaveLength(50);
  });
});
