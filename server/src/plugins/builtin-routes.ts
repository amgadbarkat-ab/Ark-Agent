/**
 * Settings for two built-in tool sets (#109), for administrators:
 * - `/api/price-list`: upload the business's price list (CSV or XLSX, the file's own bytes), see it,
 *   remove it;
 * - `/api/video/status`: whether video editing can run on this computer, and where its folders are.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import {
  BusinessFileRefusedError,
  listBusinessFiles,
  removeBusinessFile,
  saveBusinessFile,
} from "./business-files";
import {
  MAX_PRICE_LIST_BYTES,
  PriceListRefusedError,
  priceListStatus,
  removePriceList,
  savePriceList,
} from "./price-list";
import { videoSetup, videoUnavailable } from "./video";

export function createBuiltinToolRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/price-list", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json({ list: await priceListStatus() });
  });

  routes.put(
    "/price-list",
    requireUser,
    bodyLimit({
      maxSize: MAX_PRICE_LIST_BYTES,
      onError: (context) =>
        context.json({ error: "The file is larger than 8 MB." }, 413),
    }),
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) return denied;
      let fileName = "";
      try {
        fileName = decodeURIComponent(context.req.header("x-file-name") ?? "");
      } catch {
        fileName = "";
      }
      const bytes = new Uint8Array(await context.req.arrayBuffer());
      try {
        return context.json({
          list: await savePriceList({
            fileName,
            bytes,
            by: context.var.actor.id,
          }),
        });
      } catch (error) {
        if (error instanceof PriceListRefusedError) {
          return context.json({ error: error.message }, 400);
        }
        throw error;
      }
    },
  );

  routes.delete("/price-list", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await removePriceList();
    return context.body(null, 204);
  });

  // The business's own data files (#109, v0.1.43): Pylon's exports and any other table.
  routes.get("/business-files", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json({ files: await listBusinessFiles() });
  });

  routes.put(
    "/business-files/:name",
    requireUser,
    bodyLimit({
      maxSize: MAX_PRICE_LIST_BYTES,
      onError: (context) =>
        context.json({ error: "The file is larger than 8 MB." }, 413),
    }),
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) return denied;
      let fileName = "";
      try {
        fileName = decodeURIComponent(context.req.header("x-file-name") ?? "");
      } catch {
        fileName = "";
      }
      try {
        return context.json({
          file: await saveBusinessFile({
            name: context.req.param("name"),
            fileName,
            bytes: new Uint8Array(await context.req.arrayBuffer()),
            by: context.var.actor.id,
          }),
        });
      } catch (error) {
        if (error instanceof BusinessFileRefusedError) {
          return context.json({ error: error.message }, 400);
        }
        throw error;
      }
    },
  );

  routes.delete("/business-files/:name", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await removeBusinessFile(context.req.param("name"));
    return context.body(null, 204);
  });

  routes.get("/video/status", requireUser, (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const setup = videoSetup();
    return context.json({
      enabled: setup.enabled,
      ready: videoUnavailable(setup) === null,
      problem: videoUnavailable(setup),
      ffmpeg: setup.ffmpeg,
      mediaDir: setup.enabled ? setup.mediaDir : null,
    });
  });

  return routes;
}
