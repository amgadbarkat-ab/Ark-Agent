/**
 * For the board's image only (Dockerfile, build stage): copies imapflow and mailparser, with exactly
 * the packages they need, out of a frozen install of the server workspace, so the image carries a
 * few MB instead of the server's whole tree.
 *
 *   bun mail-deps.ts <repo with server/node_modules> <out dir>
 *
 * Bun installs each package once under node_modules/.bun/<name>@<version>/, with links to the exact
 * versions it needs beside it. This keeps that layout: it copies only the .bun folders of imapflow,
 * mailparser and everything they need (links kept as they are), then links the two names at the
 * top of <out dir>/node_modules. The versions are the root bun.lock's; nothing is resolved afresh.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

const [repo, out] = process.argv.slice(2);
if (!repo || !out) {
  console.error("bun mail-deps.ts <repo> <out dir>");
  process.exit(1);
}

const root = realpathSync(join(repo, "node_modules", ".bun"));
const stores = new Set<string>();
const seenDirs = new Set<string>();

/** The real folder of `name` as Node would find it from `fromDir`. */
function locate(name: string, fromDir: string): string | null {
  let at = fromDir;
  for (;;) {
    const candidate = join(at, "node_modules", name);
    if (existsSync(join(candidate, "package.json")))
      return realpathSync(candidate);
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/** node_modules/.bun/<key>/node_modules/<name> → node_modules/.bun/<key> */
function storeOf(dir: string): string {
  const rest = relative(root, dir).split(sep);
  if (rest[0] === undefined || rest[0].startsWith("..")) {
    throw new Error(`${dir} is not under ${root}`);
  }
  return join(root, rest[0]);
}

function visit(name: string, fromDir: string, optional = false) {
  const dir = locate(name, fromDir);
  if (!dir) {
    if (optional) return;
    throw new Error(`${name} not found from ${fromDir}`);
  }
  if (seenDirs.has(dir)) return;
  seenDirs.add(dir);
  stores.add(storeOf(dir));
  const manifest = JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  for (const dep of Object.keys(manifest.dependencies ?? {})) visit(dep, dir);
  for (const dep of Object.keys(manifest.optionalDependencies ?? {}))
    visit(dep, dir, true);
}

const server = realpathSync(join(repo, "server"));
const tops = ["imapflow", "mailparser"];
for (const name of tops) visit(name, server);

const outBun = join(out, "node_modules", ".bun");
mkdirSync(outBun, { recursive: true });
for (const store of stores) {
  cpSync(store, join(outBun, basename(store)), {
    recursive: true,
    verbatimSymlinks: true,
  });
}
for (const name of tops) {
  const real = locate(name, server) as string;
  const target = relative(
    join(out, "node_modules"),
    join(outBun, relative(root, real)),
  );
  symlinkSync(target, join(out, "node_modules", name));
}
console.log(
  [...stores]
    .map((store) => basename(store))
    .sort()
    .join("\n"),
);
