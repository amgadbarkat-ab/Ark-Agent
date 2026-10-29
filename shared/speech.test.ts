import { describe, expect, test } from "bun:test";
import { MAX_SPEECH_CHARACTERS, speakableText, speechVerdict } from "./speech";

describe("which messages Read aloud speaks", () => {
  test("Latin script is English and Arabic script is Arabic", () => {
    expect(speechVerdict("The report is ready.")).toEqual({
      ok: true,
      language: "en",
      text: "The report is ready.",
    });
    expect(speechVerdict("التقرير جاهز.")).toEqual({
      ok: true,
      language: "ar",
      text: "التقرير جاهز.",
    });
  });

  test("Greek is refused, alone or as a single letter inside English", () => {
    expect(speechVerdict("Η αναφορά είναι έτοιμη.")).toEqual({
      ok: false,
      reason: "language",
    });
    expect(speechVerdict("The angle is about 30° (θ).")).toEqual({
      ok: false,
      reason: "language",
    });
    expect(speechVerdict("التقرير جاهز Ω")).toEqual({
      ok: false,
      reason: "language",
    });
  });

  test("any other script is refused too", () => {
    for (const text of ["Отчёт готов.", "报告已准备好。", "רשימה מוכנה"]) {
      expect(speechVerdict(text)).toEqual({ ok: false, reason: "language" });
    }
  });

  test("a mixed message is spoken in the script with more letters", () => {
    const arabic = speechVerdict("تم تحديث لوحة المعلومات في Grafana اليوم");
    expect(arabic.ok && arabic.language).toBe("ar");
    const english = speechVerdict("The dashboard says مرحبا in the header");
    expect(english.ok && english.language).toBe("en");
  });

  test("nothing to say, and too much to say, are refused", () => {
    expect(speechVerdict("")).toEqual({ ok: false, reason: "empty" });
    expect(speechVerdict("```ts\nconst a = 1;\n```")).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(speechVerdict("12 345 — 67%")).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(speechVerdict("word ".repeat(MAX_SPEECH_CHARACTERS))).toEqual({
      ok: false,
      reason: "length",
    });
  });

  test("Greek inside a code block is not spoken, so it does not refuse the message", () => {
    expect(speechVerdict("Use this:\n```\nconst π = 3.14;\n```")).toEqual({
      ok: true,
      language: "en",
      text: "Use this:",
    });
  });
});

describe("the words that would be spoken", () => {
  test("markdown punctuation, links and code are taken out", () => {
    expect(
      speakableText(
        "## Summary\n\n- **Done:** see [the report](https://example.com/r).\n> Quoted `value`\n\n| a | b |",
      ),
    ).toBe("Summary Done: see the report. Quoted value a b");
  });
});
