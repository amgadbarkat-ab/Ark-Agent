import { expect, test } from "bun:test";
import { requestWithSingleTypes, withSingleTypes } from "./tool-schema";

test("a list of types becomes its first type that is not null, at any depth", () => {
  expect(
    withSingleTypes({
      type: "object",
      properties: {
        ids: { type: "array", items: { type: ["string", "null"] } },
        when: { type: ["null", "number"] },
        any: { anyOf: [{ type: ["boolean", "null"] }] },
      },
    }),
  ).toEqual({
    type: "object",
    properties: {
      ids: { type: "array", items: { type: "string" } },
      when: { type: "number" },
      any: { anyOf: [{ type: "boolean" }] },
    },
  });
});

test("a schema with single types is unchanged, and a property called type is left alone", () => {
  const schema = {
    type: "object",
    properties: { type: { type: "string", enum: ["a", "b"] } },
    required: ["type"],
  };
  expect(withSingleTypes(schema)).toEqual(schema);
});

test("a chat request's tools are rewritten and nothing else is", () => {
  const body = JSON.stringify({
    model: "gemma",
    messages: [{ role: "user", content: "type: [x]" }],
    tools: [
      {
        type: "function",
        function: {
          name: "pick",
          parameters: {
            type: "object",
            properties: { v: { type: ["string", "null"] } },
          },
        },
      },
    ],
  });
  const sent = JSON.parse(requestWithSingleTypes(body));
  expect(sent.tools[0].function.parameters.properties.v.type).toBe("string");
  expect(sent.messages).toEqual([{ role: "user", content: "type: [x]" }]);
  expect(requestWithSingleTypes("not json")).toBe("not json");
  expect(requestWithSingleTypes('{"model":"m"}')).toBe('{"model":"m"}');
});
