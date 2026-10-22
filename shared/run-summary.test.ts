import { expect, test } from "bun:test";
import { describeRun, hostOf, openingOf } from "./run-summary";

test("says what reached the model, without a key or a conversation", () => {
  const line = describeRun({
    runId: "r1",
    model: "command-a",
    host: "openrouter.ai",
    chosen: true,
    systemCharacters: 9000,
    roleOpening: openingOf(
      "You are Ada,\n  Chief of Operations. You lead this team.",
      20,
    ),
    roleCharacters: 700,
    toolsOffered: ["team_ask", "team_list"],
    toolsLeftOut: [],
  });
  expect(line).toBe(
    'run r1: model=command-a host=openrouter.ai chosen=true system=9000 chars role=700 chars role_opening="You are Ada, Chief o" tools=2 [team_ask,team_list] left_out=[none]',
  );
});

test("reads the host of an address and nothing else", () => {
  expect(hostOf("https://openrouter.ai/api/v1")).toBe("openrouter.ai");
  expect(hostOf("http://127.0.0.1:8080/v1")).toBe("127.0.0.1:8080");
  expect(hostOf("not an address")).toBe("");
  expect(hostOf(undefined)).toBe("");
});
