/**
 * English written straight into a screen, where a person choosing Greek would still read it (#108).
 *
 * Read with the TypeScript compiler, not with patterns, so a word inside a class name or a URL is
 * never mistaken for a sentence. Three things are found:
 *  - JSX text: `<p>Save your work</p>`;
 *  - a string given to a prop a person reads (anything but the technical ones below);
 *  - every text given to `t(…)` / `tNow(…)`, so the test can check each has its Greek.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

export type Finding = { file: string; line: number; text: string };

/** Props that carry code, not words. */
const TECHNICAL_PROPS = new Set([
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

/** A word a person reads: two or more Latin letters. Brand names alone are allowed. */
const WORDS = /[A-Za-z]{2,}/;
const BRAND_ONLY =
  /^(ArkAgent|Ark|OpenBot|Gmail|Google|Google Drive|Outlook|Microsoft 365|Microsoft|Telegram|WhatsApp|Slack|Notion|Composio|Stripe|Paddle|Mercury 3|Gemma|Claude|OpenAI|Anthropic|GitHub|MCP|API|URL|ID|PIN|OK|EUR|USD|PDF|CSV|JSON|HTML|SSO|OIDC|SAML|SCIM|Docker|Podman|Windows|macOS|Linux|Chrome|Edge|E-mail|Email|AI|[A-Z]{2,5}|\W+|[\d\s.,:/%+-]+)$/;

function isWords(text: string): boolean {
  const trimmed = text.trim();
  return WORDS.test(trimmed) && !BRAND_ONLY.test(trimmed);
}

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== "routeTree.gen.ts") out.push(path);
  }
  return out;
}

/**
 * A string that ends up on screen: inside a `{…}` in JSX (directly, or as a branch of a condition),
 * and not an argument to a call, an attribute that carries code, a comparison operand or a key.
 */
function shownInJsx(node: ts.Node, source: ts.SourceFile): boolean {
  let current: ts.Node = node;
  while (current.parent) {
    const parent: ts.Node = current.parent;
    if (ts.isJsxExpression(parent)) {
      const holder = parent.parent;
      if (holder && ts.isJsxAttribute(holder)) {
        const prop = holder.name.getText(source);
        return !TECHNICAL_PROPS.has(prop) && !prop.endsWith("ClassName") && !prop.startsWith("on") && !prop.startsWith("data-");
      }
      return true;
    }
    if (
      ts.isConditionalExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      (ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) ||
      ts.isTemplateSpan(parent) ||
      ts.isTemplateExpression(parent)
    ) {
      if (ts.isConditionalExpression(parent) && parent.condition === current) return false;
      current = parent;
      continue;
    }
    return false;
  }
  return false;
}

export function scan(
  root: string,
  skip: (file: string) => boolean = () => false,
): { raw: Finding[]; translated: Finding[] } {
  const raw: Finding[] = [];
  const translated: Finding[] = [];
  for (const path of files(root)) {
    const file = relative(root, path);
    if (skip(file)) continue;
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const at = (node: ts.Node) =>
      source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const visit = (node: ts.Node) => {
      const inCode = (n: ts.Node) =>
        ts.isJsxElement(n.parent) &&
        /^(code|kbd|pre|samp)$/.test(n.parent.openingElement.tagName.getText(source));
      if (ts.isJsxText(node) && isWords(node.text) && !inCode(node)) {
        raw.push({ file, line: at(node), text: node.text.trim() });
      } else if (
        ts.isJsxAttribute(node) &&
        node.initializer &&
        ts.isStringLiteral(node.initializer)
      ) {
        const prop = node.name.getText(source);
        if (
          !TECHNICAL_PROPS.has(prop) &&
          !prop.startsWith("data-") &&
          !prop.endsWith("ClassName") &&
          !prop.startsWith("on") &&
          isWords(node.initializer.text) &&
          /\s|^[A-Z][a-z]/.test(node.initializer.text)
        ) {
          raw.push({ file, line: at(node), text: node.initializer.text });
        }
      } else if (
        (ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateExpression(node)) &&
        shownInJsx(node, source)
      ) {
        const text = ts.isTemplateExpression(node)
          ? node.getText(source).slice(1, -1)
          : node.text;
        if (isWords(text) && /\s/.test(text.trim()) && /^[A-Z“"(]/.test(text.trim())) {
          raw.push({ file, line: at(node), text });
        }
      } else if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "t" || node.expression.text === "tNow")
      ) {
        const first = node.arguments[0];
        if (
          first &&
          (ts.isStringLiteral(first) ||
            ts.isNoSubstitutionTemplateLiteral(first))
        ) {
          translated.push({ file, line: at(first), text: first.text });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { raw, translated };
}

if (import.meta.main) {
  const { raw } = scan(join(import.meta.dir, "../../src"), (file) =>
    file.startsWith("components/ui/"),
  );
  const only = process.argv[2];
  if (only) {
    for (const finding of raw.filter((f) => f.file.includes(only)))
      console.log(`${finding.file}:${finding.line}  ${finding.text}`);
    process.exit(0);
  }
  const byFile = new Map<string, number>();
  for (const finding of raw)
    byFile.set(finding.file, (byFile.get(finding.file) ?? 0) + 1);
  for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1]))
    console.log(String(count).padStart(4), file);
  console.log(raw.length, "English texts written straight into screens");
}
