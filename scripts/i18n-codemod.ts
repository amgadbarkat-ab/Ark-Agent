/**
 * One-off helper for #108: wrap English written straight into screens in `t(…)`.
 *
 * For each .tsx file given (or every screen file), using the TypeScript AST:
 *  - JSX text that stands alone in its element becomes `{t("…")}`;
 *  - a string given to a prop a person reads becomes `prop={t("…")}`;
 *  - the nearest enclosing component (a function named in capitals, or a `use…` hook) gets
 *    `const t = useT();` and the file gets the import. Where there is no component to put a hook in,
 *    `tNow` is used instead.
 * Text mixed with `{expressions}` in one element is NOT wrapped: Greek word order is not English
 * word order, so those are written by hand as one sentence with `{placeholders}`. They are listed.
 *
 * Prints every English text it wrapped, one per line, prefixed with `+`, and every one it left for
 * hand-writing, prefixed with `!`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { scan } from "../app/tests/support/english-scan";

const TECHNICAL_PROPS_PATH = "../app/tests/support/english-scan";
void TECHNICAL_PROPS_PATH;

type Edit = { start: number; end: number; text: string };

function componentOf(node: ts.Node): ts.FunctionLikeDeclaration | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) &&
      current.name &&
      /^([A-Z]|use[A-Z])/.test(current.name.text)
    )
      return current;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name) &&
      /^([A-Z]|use[A-Z])/.test(current.parent.name.text)
    )
      return current;
    // forwardRef / memo wrappers around an arrow
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isCallExpression(current.parent) &&
      ts.isVariableDeclaration(current.parent.parent) &&
      ts.isIdentifier(current.parent.parent.name) &&
      /^[A-Z]/.test(current.parent.parent.name.text)
    )
      return current;
    current = current.parent;
  }
  return null;
}

/** True when a nested non-component function sits between the node and the component. */
function insideCallback(node: ts.Node, component: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== component) {
    if (ts.isFunctionLike(current)) {
      // A render callback inside JSX (`.map(item => <p>…</p>)`) is still the component's render.
      return false;
    }
    current = current.parent;
  }
  return false;
}
void insideCallback;

const quote = (text: string) => JSON.stringify(text);
const ENTITIES: Record<string, string> = { rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", hellip: "…", mdash: "—", ndash: "–", middot: "·" };
const decodeEntities = (text: string) => text.replace(/&([a-z]+);/g, (whole, name: string) => ENTITIES[name] ?? whole);

function convert(path: string) {
  const original = readFileSync(path, "utf8");
  const source = ts.createSourceFile(
    path,
    original,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const findings = scan.length; // keep import used
  void findings;
  const edits: Edit[] = [];
  const hooked = new Set<ts.FunctionLikeDeclaration>();
  let usedNow = false;
  let usedT = false;
  const wrapped: string[] = [];
  const left: string[] = [];

  const WORDS = /[A-Za-z]{2,}/;
  const TECH = new Set([
    "className",
    "href",
    "to",
    "from",
    "type",
    "id",
    "key",
    "variant",
    "size",
    "role",
    "name",
    "value",
    "defaultValue",
    "htmlFor",
    "target",
    "rel",
    "src",
    "method",
    "autoComplete",
    "inputMode",
    "pattern",
    "align",
    "side",
    "orientation",
    "mode",
    "tone",
    "icon",
    "lang",
    "dir",
    "form",
    "accept",
    "spacerClassName",
    "messageId",
    "enterKeyHint",
    "tabIndex",
    "color",
    "fill",
    "stroke",
    "d",
    "viewBox",
    "xmlns",
    "path",
    "hash",
    "search",
    "params",
    "fallback",
    "sandbox",
    "allow",
    "referrerPolicy",
    "style",
    "width",
    "height",
    "loading",
    "decoding",
    "kind",
    "slot",
    "behavior",
    "direction",
    "scrollBehavior",
    "defaultScrollPosition",
    "autoCapitalize",
    "spellCheck",
    "testId",
    "preserveAspectRatio",
    "transform",
    "gradientTransform",
    "result",
    "in",
    "in2",
    "floodColor",
    "stopColor",
    "mask",
    "filter",
    "clipPath",
    "colorInterpolationFilters",
    "mode",
  ]);
  const BRAND_ONLY =
    /^(ArkAgent|Ark|OpenBot|Gmail|Google|Google Drive|Outlook|Microsoft 365|Microsoft|Telegram|WhatsApp|Slack|Notion|Composio|Stripe|Paddle|Mercury 3|Gemma|Claude|OpenAI|Anthropic|GitHub|MCP|API|URL|ID|PIN|OK|EUR|USD|PDF|CSV|JSON|HTML|SSO|OIDC|SAML|SCIM|Docker|Podman|Windows|macOS|Linux|Chrome|Edge|E-mail|Email|AI|[A-Z]{2,5}|\W+|[\d\s.,:/%+-]+)$/;
  const words = (t: string) =>
    WORDS.test(t.trim()) && !BRAND_ONLY.test(t.trim());

  const callFor = (node: ts.Node): string => {
    const component = componentOf(node);
    if (component) {
      hooked.add(component);
      usedT = true;
      return "t";
    }
    usedNow = true;
    return "tNow";
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && words(node.text)) {
      const parent = node.parent;
      const siblings =
        ts.isJsxElement(parent) || ts.isJsxFragment(parent)
          ? parent.children
          : [];
      const mixed = siblings.some(
        (child) =>
          child !== node &&
          (ts.isJsxExpression(child) && child.expression !== undefined
            ? !(
                ts.isCallExpression(child.expression) &&
                /^(t|tNow)$/.test(child.expression.expression.getText(source))
              )
            : false),
      );
      const otherText = siblings.some(
        (child) => child !== node && ts.isJsxText(child) && words(child.text),
      );
      const normal = decodeEntities(node.text.replace(/\s+/g, " ").trim());
      if (mixed || otherText) {
        left.push(normal);
      } else {
        const lead =
          /^[ \t]+\S/.test(node.text) && !/^\s*\n/.test(node.text)
            ? '{" "}'
            : "";
        const trail =
          /\S[ \t]+$/.test(node.text) && !/\n\s*$/.test(node.text)
            ? '{" "}'
            : "";
        const fn = callFor(node);
        // Keep the line breaks around the text so formatting stays put.
        const before = node.text.match(/^\s*/)?.[0] ?? "";
        const after = node.text.match(/\s*$/)?.[0] ?? "";
        const keepBefore = before.includes("\n") ? before : "";
        const keepAfter = after.includes("\n") ? after : "";
        edits.push({
          start:
            node.getStart(source, false) -
            (node.getStart(source, false) - node.pos),
          end: node.end,
          text: `${keepBefore}${lead}{${fn}(${quote(normal)})}${trail}${keepAfter}`,
        });
        wrapped.push(normal);
      }
    } else if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      const prop = node.name.getText(source);
      const value = node.initializer.text;
      if (
        !TECH.has(prop) &&
        !prop.startsWith("data-") &&
        !prop.endsWith("ClassName") &&
        !prop.startsWith("on") &&
        words(value) &&
        /\s|^[A-Z][a-z]/.test(value)
      ) {
        const fn = callFor(node);
        edits.push({
          start: node.initializer.getStart(source),
          end: node.initializer.end,
          text: `{${fn}(${quote(value)})}`,
        });
        wrapped.push(value);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (edits.length === 0) return { wrapped, left };

  // Hooks: one `const t = useT();` at the top of each component body that needs it and lacks it.
  for (const component of hooked) {
    const body = component.body;
    if (!body) continue;
    if (ts.isBlock(body)) {
      if (/\bconst t = useT\(\)/.test(body.getText(source))) continue;
      edits.push({
        start: body.getStart(source) + 1,
        end: body.getStart(source) + 1,
        text: "\n  const t = useT();",
      });
    } else {
      // Concise arrow body: give it a block.
      edits.push({
        start: body.getStart(source),
        end: body.getStart(source),
        text: "{\n  const t = useT();\n  return (",
      });
      edits.push({ start: body.end, end: body.end, text: ");\n}" });
    }
  }

  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let text = original;
  for (const edit of edits)
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);

  // Import.
  const names = [usedT ? "useT" : null, usedNow ? "tNow" : null].filter(
    Boolean,
  ) as string[];
  const existing = text.match(/import \{([^}]*)\} from "@\/lib\/i18n";/);
  if (existing) {
    const have = new Set(
      existing[1]
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean),
    );
    for (const n of names) have.add(n);
    text = text.replace(
      existing[0],
      `import { ${[...have].sort().join(", ")} } from "@/lib/i18n";`,
    );
  } else if (names.length) {
    // After the last import.
    const lastImport = [
      ...text.matchAll(/^import [\s\S]*?from "[^"]+";\n/gm),
    ].pop();
    const at = lastImport ? (lastImport.index ?? 0) + lastImport[0].length : 0;
    text = `${text.slice(0, at)}import { ${names.sort().join(", ")} } from "@/lib/i18n";\n${text.slice(at)}`;
  }
  writeFileSync(path, text);
  return { wrapped, left };
}

for (const path of process.argv.slice(2)) {
  const { wrapped, left } = convert(path);
  for (const w of wrapped) console.log(`+ ${w}`);
  for (const l of left) console.log(`! ${path}: ${l}`);
}
