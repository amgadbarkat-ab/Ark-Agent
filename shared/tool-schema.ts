/**
 * Tool schemas a model on this computer can read.
 *
 * JSON Schema allows a list of types (`"type": ["string", "null"]`). Gemma 4's chat template formats a
 * tool's parameters with a Jinja `map` filter that the bundled llama.cpp does not implement, so one such
 * parameter anywhere in the tools made every request fail with HTTP 500 ("NotImplemented: map:
 * filter-mapping not implemented"), and with it every chat with a built-in employee on the local model.
 * One of the app's own screen tools has exactly that parameter.
 *
 * A list becomes its first type that is not "null". The model loses only the hint that a value may be
 * empty, which it can still leave out; a hosted model is never sent through this.
 */
export function withSingleTypes<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(withSingleTypes) as T;
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type" && Array.isArray(value)) {
      const named = value.filter(
        (type): type is string => typeof type === "string",
      );
      out.type = named.find((type) => type !== "null") ?? named[0] ?? "string";
      continue;
    }
    out[key] = withSingleTypes(value);
  }
  return out as T;
}

/** The same, applied to the tools of an OpenAI-shaped chat request body. */
export function requestWithSingleTypes(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  const tools = (parsed as { tools?: unknown }).tools;
  if (!Array.isArray(tools) || tools.length === 0) return body;
  return JSON.stringify({
    ...(parsed as object),
    tools: withSingleTypes(tools),
  });
}
