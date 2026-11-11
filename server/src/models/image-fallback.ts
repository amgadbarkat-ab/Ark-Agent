/**
 * A model that cannot see images is told an image was there, instead of the chat breaking (desk #83).
 *
 * DT Lab, v0.1.27, Mercury 3: attaching a .png got a raw red `400 … "Image inputs are not supported
 * for this model"`, and the conversation then stayed broken, because the image is in its history and
 * history is replayed on every turn. Only a new conversation worked.
 *
 * Nothing here keeps a list of which models see images: providers change that without telling
 * anybody, and a person's own endpoint is not on any list. The provider is asked, and its refusal is
 * the answer. When a request that carries an image is refused in words that say images are the
 * reason, the same request is sent once more with each image replaced by a sentence saying an image
 * was attached that this model cannot see. The model then tells the person so in its own words, and
 * the conversation carries on. The address and model are remembered for the life of the process, so
 * later requests go out without their images the first time.
 *
 * This sits at the one place a request leaves for a model, which is why it covers a built-in
 * digital employee, a hired one going through the gateway, and the model on this computer alike.
 */

/** What stands in for an image the model cannot see. Written to the model, not to the person. */
export const IMAGE_NOTE =
  "[The person attached an image here, but the model you are running on cannot see images. Tell them plainly that you cannot see the image, and that they can choose a model that sees images under Settings, then Models.]";

/** Addresses and models that have said they take no images, as `url\nmodel`. */
const textOnly = new Set<string>();

/** For tests: forget what has been learned. */
export function forgetTextOnlyModels(): void {
  textOnly.clear();
}

const IMAGE_PART_TYPES = new Set(["image_url", "input_image", "image"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every image part replaced by the note, in whichever dialect the body is written: OpenAI's chat
 * (`image_url`), OpenAI's Responses (`input_image`) or Anthropic's (`image`). Parts live in arrays,
 * at any depth (a tool result can hold one), so the walk is over the whole body.
 */
function withoutImages(value: unknown): { value: unknown; found: number } {
  if (Array.isArray(value)) {
    let found = 0;
    const next = value.map((item) => {
      if (
        isRecord(item) &&
        typeof item.type === "string" &&
        IMAGE_PART_TYPES.has(item.type)
      ) {
        found += 1;
        return item.type === "input_image"
          ? { type: "input_text", text: IMAGE_NOTE }
          : { type: "text", text: IMAGE_NOTE };
      }
      const inner = withoutImages(item);
      found += inner.found;
      return inner.value;
    });
    return { value: found > 0 ? next : value, found };
  }
  if (isRecord(value)) {
    let found = 0;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const inner = withoutImages(item);
      found += inner.found;
      next[key] = inner.value;
    }
    return { value: found > 0 ? next : value, found };
  }
  return { value, found: 0 };
}

/** The request body with its images replaced, and the model it names; null when it carries none. */
export function stripImages(
  body: string,
): { body: string; model: string } | null {
  // Cheap refusal first: most requests carry no image, and are not parsed at all.
  if (!/"(image_url|input_image|image)"/.test(body)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const stripped = withoutImages(parsed);
  if (stripped.found === 0) return null;
  return {
    body: JSON.stringify(stripped.value),
    model: typeof parsed.model === "string" ? parsed.model : "",
  };
}

/**
 * Whether a refusal says images are why. Deliberately about the words, since the status differs:
 * Inception answers 400 ("Image inputs are not supported for this model"), llama.cpp 500 ("image
 * input is not supported - hint: … mmproj"), OpenAI 400 ("image_url is only supported by certain
 * models").
 */
export function saysImagesUnsupported(status: number, text: string): boolean {
  if (status < 400) return false;
  // A complaint about THIS image (its format, its size) is not a model that takes no images, and
  // remembering it as one would take images away from a model that sees them.
  if (
    /format|media type|mime|too large|too big|dimension|decode|corrupt/i.test(
      text,
    )
  )
    return false;
  return (
    /image/i.test(text) &&
    /not supported|unsupported|only supported|does(?: not|n't) support|cannot (?:accept|process|read|see)|mmproj|multimodal|vision/i.test(
      text,
    )
  );
}

type Send = (body: string) => Promise<Response>;

/**
 * Send `body` to `url`, and if it is refused because of its images, send it once more without them.
 * `send` is called with the body to use; everything else about the request is the caller's.
 */
export async function sendWithImageFallback(
  url: string,
  body: string,
  send: Send,
): Promise<Response> {
  const stripped = stripImages(body);
  if (!stripped) return send(body);
  const key = `${url}\n${stripped.model}`;
  if (textOnly.has(key)) return send(stripped.body);

  const response = await send(body);
  if (response.ok) return response;
  // Read a copy, so the refusal can still be handed back whole when it is about something else.
  const text = await response
    .clone()
    .text()
    .catch(() => "");
  if (!saysImagesUnsupported(response.status, text)) return response;
  textOnly.add(key);
  return send(stripped.body);
}

/** A `fetch` that does the above for every request whose body is a string, which is how SDKs send. */
export function fetchWithImageFallback(inner: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!init || typeof init.body !== "string") return inner(input, init);
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    return sendWithImageFallback(url, init.body, (body) =>
      inner(input, { ...init, body }),
    );
  }) as typeof fetch;
}
