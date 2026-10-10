import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { termsVersionOf } from "./terms";
import { TERMS_VERSION } from "./terms-version";

test("reads the version from its one line", () => {
  expect(termsVersionOf("# T\n\n**Version:** 2026-11-01\n\ntext")).toBe(
    "2026-11-01",
  );
  expect(termsVersionOf("**Version:**   v3  \nx")).toBe("v3");
});

test("refuses text that declares no version, or two", () => {
  expect(() => termsVersionOf("# T\n\nno version here")).toThrow(
    /exactly once/,
  );
  expect(() => termsVersionOf("**Version:** a\n\n**Version:** b")).toThrow(
    /found 2/,
  );
  // Mentioned in prose is not declared.
  expect(() => termsVersionOf("The **Version:** line is below.")).toThrow();
});

test("the committed version is the one in the document", () => {
  // Fails when the document's version was changed and the generator was not run, which would leave
  // the server asking people to accept a version the app is not showing.
  const document = readFileSync(
    resolve(import.meta.dir, "../docs/legal/terms-of-service.md"),
    "utf8",
  );
  expect(TERMS_VERSION).toBe(termsVersionOf(document));
});
