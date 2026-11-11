import { beforeEach, describe, expect, test } from "bun:test";
import {
  fetchWithImageFallback,
  forgetTextOnlyModels,
  IMAGE_NOTE,
  saysImagesUnsupported,
  sendWithImageFallback,
  stripImages,
} from "../src/models/image-fallback";

/**
 * Desk #83 (a) and (b): a .png sent to Mercury 3 got a raw 400, and the conversation stayed broken
 * because the image is replayed with its history on every turn.
 */

const MERCURY_REFUSAL = JSON.stringify([
  {
    type: "value_error",
    msg: "Value error, Image inputs are not supported for this model",
  },
]);

const PNG = "data:image/png;base64,iVBORw0KGgo=";

const chatBody = (model = "mercury-3") =>
  JSON.stringify({
    model,
    messages: [
      { role: "system", content: "You are Sales." },
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this picture?" },
          { type: "image_url", image_url: { url: PNG } },
        ],
      },
    ],
  });

beforeEach(() => forgetTextOnlyModels());

/** A provider that refuses any request with an image in it, as Mercury 3 does. */
function textOnlyProvider() {
  const seen: string[] = [];
  const send = async (body: string) => {
    seen.push(body);
    return body.includes("image_url")
      ? new Response(MERCURY_REFUSAL, { status: 400 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return { seen, send };
}

describe("a model that cannot see images", () => {
  test("is asked again without the image, and told one was attached", async () => {
    const { seen, send } = textOnlyProvider();

    const response = await sendWithImageFallback(
      "https://m/v1/chat",
      chatBody(),
      send,
    );

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
    const second = JSON.parse(seen[1] as string);
    expect(second.messages[1].content).toEqual([
      { type: "text", text: "What is in this picture?" },
      { type: "text", text: IMAGE_NOTE },
    ]);
    // Everything that was not an image is exactly as it was sent.
    expect(second.messages[0]).toEqual({
      role: "system",
      content: "You are Sales.",
    });
  });

  test("the conversation is not broken afterwards: later turns go out without the image, once", async () => {
    const { seen, send } = textOnlyProvider();
    await sendWithImageFallback("https://m/v1/chat", chatBody(), send);
    seen.length = 0;

    // The next message replays the same history, image and all.
    const response = await sendWithImageFallback(
      "https://m/v1/chat",
      chatBody(),
      send,
    );

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain("image_url");
  });

  test("another model at the same address is asked for itself", async () => {
    const { seen, send } = textOnlyProvider();
    await sendWithImageFallback(
      "https://m/v1/chat",
      chatBody("mercury-3"),
      send,
    );
    seen.length = 0;
    await sendWithImageFallback("https://m/v1/chat", chatBody("other"), send);
    expect(seen[0]).toContain("image_url");
  });
});

describe("what is left alone", () => {
  test("a request with no image is sent as it is, and a refusal comes back whole", async () => {
    const body = JSON.stringify({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    let calls = 0;
    const response = await sendWithImageFallback(
      "https://m/v1/chat",
      body,
      async (sent) => {
        calls += 1;
        expect(sent).toBe(body);
        return new Response("rate limited", { status: 429 });
      },
    );
    expect(calls).toBe(1);
    expect(await response.text()).toBe("rate limited");
  });

  test("a refusal about something else is handed back, readable, and nothing is remembered", async () => {
    let calls = 0;
    const send = async () => {
      calls += 1;
      return new Response("Incorrect API key provided", { status: 401 });
    };
    const response = await sendWithImageFallback(
      "https://m/v1/chat",
      chatBody(),
      send,
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Incorrect API key provided");
    expect(calls).toBe(1);
  });

  test("a complaint about this image's format is not a model that takes no images", () => {
    expect(
      saysImagesUnsupported(
        400,
        "You uploaded an unsupported image. Use one of these formats: png, jpeg.",
      ),
    ).toBe(false);
    expect(saysImagesUnsupported(413, "image too large")).toBe(false);
  });
});

describe("the words providers use", () => {
  test.each([
    [400, MERCURY_REFUSAL],
    [
      500,
      "image input is not supported - hint: if this is unexpected, you may need to provide the mmproj",
    ],
    [
      400,
      "Invalid content type. image_url is only supported by certain models.",
    ],
    [400, "this model does not support images"],
  ])("%i %s", (status, text) => {
    expect(saysImagesUnsupported(status, text)).toBe(true);
  });

  test("a success is never a refusal", () => {
    expect(saysImagesUnsupported(200, "image not supported")).toBe(false);
  });
});

describe("each dialect's image part", () => {
  test("OpenAI Responses", () => {
    const stripped = stripImages(
      JSON.stringify({
        model: "m",
        input: [
          { role: "user", content: [{ type: "input_image", image_url: PNG }] },
        ],
      }),
    );
    expect(JSON.parse(stripped?.body ?? "{}").input[0].content).toEqual([
      { type: "input_text", text: IMAGE_NOTE },
    ]);
  });

  test("Anthropic, including an image inside a tool result", () => {
    const stripped = stripImages(
      JSON.stringify({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "x" },
              },
              {
                type: "tool_result",
                tool_use_id: "t",
                content: [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: "y",
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const content = JSON.parse(stripped?.body ?? "{}").messages[0].content;
    expect(content[0]).toEqual({ type: "text", text: IMAGE_NOTE });
    expect(content[1].content).toEqual([{ type: "text", text: IMAGE_NOTE }]);
  });

  test("text that merely mentions an image is not an image", () => {
    expect(
      stripImages(
        JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "an image_url please" }],
        }),
      ),
    ).toBeNull();
  });
});

test("as a fetch: the SDK's request is retried without its image", async () => {
  const { seen, send } = textOnlyProvider();
  const fetchImpl = fetchWithImageFallback(((
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => send(String(init?.body))) as typeof fetch);

  const response = await fetchImpl("https://m/v1/chat/completions", {
    method: "POST",
    body: chatBody(),
  });

  expect(response.status).toBe(200);
  expect(seen).toHaveLength(2);
});
