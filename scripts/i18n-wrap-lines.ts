/**
 * One-off helper for #108: wrap the string literals on the given `file:line`s (relative to app/src)
 * in `tNow(…)`. A template literal becomes one sentence with `{placeholders}`. The language switch
 * reloads the app, so `tNow` is right even in a module-level constant.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const root = join(import.meta.dir, "../app/src");
const wanted = new Map<string, Set<number>>();
for (const entry of readFileSync(process.argv[2], "utf8")
  .split("\n")
  .filter(Boolean)) {
  const [file, line] = [
    entry.slice(0, entry.lastIndexOf(":")),
    Number(entry.slice(entry.lastIndexOf(":") + 1)),
  ];
  if (!wanted.has(file)) wanted.set(file, new Set());
  wanted.get(file)?.add(line);
}
const quote = (text: string) => JSON.stringify(text);
for (const [file, lines] of wanted) {
  const path = join(root, file);
  const original = readFileSync(path, "utf8");
  const source = ts.createSourceFile(
    path,
    original,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    const line =
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      lines.has(line)
    ) {
      const text = node.text.trim();
      if (
        /^[A-Z“"(][a-z]/.test(text) &&
        (/\s/.test(text) || process.env.SINGLE === "1")
      ) {
        // A JSX attribute value needs braces.
        const inAttr = ts.isJsxAttribute(node.parent);
        edits.push({
          start: node.getStart(source),
          end: node.end,
          text: inAttr
            ? `{tNow(${quote(node.text)})}`
            : `tNow(${quote(node.text)})`,
        });
      }
    } else if (ts.isTemplateExpression(node) && lines.has(line)) {
      const names: string[] = [];
      const values: string[] = [];
      let key = node.head.text;
      for (const span of node.templateSpans) {
        const expr = span.expression;
        let name = ts.isIdentifier(expr)
          ? expr.text
          : ts.isPropertyAccessExpression(expr)
            ? expr.name.text
            : ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)
              ? expr.expression.text
              : `value${names.length + 1}`;
        while (names.includes(name)) name = `${name}${names.length + 1}`;
        names.push(name);
        values.push(`${name}: ${expr.getText(source)}`);
        key += `{${name}}${span.literal.text}`;
      }
      if (/^[A-Z“"(][a-z]/.test(key.trim())) {
        edits.push({
          start: node.getStart(source),
          end: node.end,
          text: `tNow(${quote(key)}, { ${values.join(", ")} })`,
        });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!edits.length) continue;
  edits.sort((a, b) => b.start - a.start);
  let text = original;
  for (const e of edits)
    text = text.slice(0, e.start) + e.text + text.slice(e.end);
  const im = text.match(/import \{([^}]*)\} from "@\/lib\/i18n";/);
  const relImport =
    file.startsWith("lib/") && !file.includes("/") ? "./i18n" : "@/lib/i18n";
  if (im) {
    const names = new Set(
      im[1]
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean),
    );
    names.add("tNow");
    text = text.replace(
      im[0],
      `import { ${[...names].sort().join(", ")} } from "@/lib/i18n";`,
    );
  } else if (!/import \{[^}]*tNow[^}]*\} from/.test(text)) {
    const imports = [...text.matchAll(/^import [\s\S]*?from "[^"]+";\n/gm)];
    const at = imports.length
      ? (imports[imports.length - 1].index ?? 0) +
        imports[imports.length - 1][0].length
      : 0;
    text = `${text.slice(0, at)}import { tNow } from "${relImport}";\n${text.slice(at)}`;
  }
  writeFileSync(path, text);
  console.log(file, edits.length);
}
