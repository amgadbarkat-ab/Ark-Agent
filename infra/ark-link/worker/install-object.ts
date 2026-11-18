/**
 * One customer's desktop on the Workers relay (#149): a Durable Object per install, holding the
 * desktop's WebSocket with the Hibernation API, and every paired phone's requests and sockets for it.
 * The streams are `../desk-link.ts`, the same as the Bun relay's.
 *
 * SLEEPING. With nothing in flight the object hibernates and costs no duration; the runtime keeps the
 * desktop's socket and the phones' sockets open. The desktop's heartbeat is answered by the runtime
 * itself (auto-response), so an idle desktop never wakes it. When a message wakes it, the phone sockets
 * it kept are taken back from their attachments. An HTTP request in flight keeps it awake until it is
 * answered, which is also what streams its body through.
 */
import {
  ARK_LINK_PROTOCOL_VERSION,
  BEAT,
  DESK_CLOSE,
  type DeskMessage,
  decodeDeskMessage,
  encodeControl,
  type RelayMessage,
} from "../../../shared/ark-link";
import {
  Buckets,
  DeskLink,
  type DeviceRoute,
  type Limits,
  limited,
  limitsWith,
  offline,
} from "../desk-link";
import { call } from "./directory-object";
import type { CfWebSocket, DurableObjectState, Env, Platform } from "./types";

type DeskAttachment = { kind: "desk"; installId: string };
type PhoneAttachment = { kind: "phone"; s: number; deviceId: string };

/** Headers this Worker sets on what it hands an install object; never from outside. */
export const INTERNAL = {
  install: "x-link-install",
  version: "x-link-version",
  route: "x-link-route",
  token: "x-link-token",
} as const;

export class InstallObject {
  private link: DeskLink | null = null;
  private perDevice: Buckets;
  private limits: Limits;

  constructor(
    private state: DurableObjectState,
    private env: Env,
    private platform: Platform,
    limits: Partial<Limits> = {},
    now: () => number = Date.now,
  ) {
    this.limits = limitsWith(limits);
    this.perDevice = new Buckets(
      this.limits.burst,
      this.limits.requestsPerMinute,
      now,
    );
    // Answered by the runtime without waking this object (no duration, not billed).
    state.setWebSocketAutoResponse(platform.autoResponse(BEAT, BEAT));
  }

  private desk(): CfWebSocket | undefined {
    return this.state.getWebSockets("desk")[0];
  }

  private installId(): string | undefined {
    const desk = this.desk();
    return desk
      ? (desk.deserializeAttachment() as DeskAttachment).installId
      : undefined;
  }

  private directory() {
    return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"));
  }

  /** The streams, rebuilt after hibernation from the phone sockets the runtime kept. */
  private streams(): DeskLink {
    if (this.link) return this.link;
    const link = new DeskLink({
      send: (frame) => this.desk()?.send(frame),
      limits: this.limits,
      secure: this.env.LINK_ORIGIN.startsWith("https:"),
    });
    for (const phone of this.state.getWebSockets("phone")) {
      const attachment = phone.deserializeAttachment() as PhoneAttachment;
      link.adoptPhone(attachment.s, attachment.deviceId, socketOf(phone));
    }
    this.link = link;
    return link;
  }

  private control(message: RelayMessage) {
    this.desk()?.send(encodeControl(message));
  }

  async fetch(request: Request): Promise<Response> {
    // A phone's request first: the Worker always names its route, so whatever path a phone asks for
    // (`/_internal/send` included) is the desktop's app, never this object's own door.
    const routeHeader = request.headers.get(INTERNAL.route);
    if (routeHeader) {
      const route = JSON.parse(routeHeader) as DeviceRoute;
      const token = request.headers.get(INTERNAL.token) ?? "";
      // The Worker's own headers stop here; the desktop sees the phone's request as it was.
      const headers = new Headers(request.headers);
      for (const name of Object.values(INTERNAL)) headers.delete(name);
      return this.forward(new Request(request, { headers }), route, token);
    }
    const installId = request.headers.get(INTERNAL.install);
    if (installId) return this.acceptDesk(request, installId);
    if (new URL(request.url).pathname === "/_internal/send") {
      const { message } = (await request.json()) as { message: RelayMessage };
      this.control(message);
      return Response.json({ ok: true });
    }
    return new Response("Not found.", { status: 404 });
  }

  private async acceptDesk(request: Request, installId: string) {
    const { client, server } = this.platform.socketPair();
    if (
      Number(request.headers.get(INTERNAL.version)) !==
      ARK_LINK_PROTOCOL_VERSION
    ) {
      server.accept?.();
      server.close(
        DESK_CLOSE.version,
        `This relay speaks Ark Link ${ARK_LINK_PROTOCOL_VERSION}.`,
      );
      return this.platform.upgraded(client);
    }
    for (const previous of this.state.getWebSockets("desk"))
      previous.close(DESK_CLOSE.replaced, "Another connection took over.");
    this.link?.drop();
    this.link = null;
    this.state.acceptWebSocket(server, ["desk"]);
    server.serializeAttachment({
      kind: "desk",
      installId,
    } satisfies DeskAttachment);
    const android = this.env.ARK_ANDROID_APP_ID?.trim();
    server.send(
      encodeControl({
        t: "hello",
        v: ARK_LINK_PROTOCOL_VERSION,
        installId,
        linkOrigin: this.env.LINK_ORIGIN.replace(/\/+$/, ""),
        ...(android ? { androidPackage: android } : {}),
      }),
    );
    await call(this.directory(), "/desk", { installId, connected: true });
    return this.platform.upgraded(client);
  }

  private async forward(request: Request, route: DeviceRoute, token: string) {
    if (!this.desk()) return offline(request);
    if (!this.perDevice.take(route.id)) return limited();
    const link = this.streams();
    if (link.openFor(route.id) >= this.limits.maxStreamsPerDevice)
      return limited();
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return link.forwardHttp(request, route, token);
    const opened = await link.openSocket(request, route, token);
    if (!opened)
      return new Response("The computer did not accept the connection.", {
        status: 502,
      });
    const { client, server } = this.platform.socketPair();
    this.state.acceptWebSocket(server, ["phone"]);
    server.serializeAttachment({
      kind: "phone",
      s: opened.s,
      deviceId: route.id,
    } satisfies PhoneAttachment);
    link.attachPhone(opened.s, socketOf(server));
    return this.platform.upgraded(
      client,
      opened.protocol ? { "sec-websocket-protocol": opened.protocol } : {},
    );
  }

  // ---- the Hibernation API's handlers ---------------------------------------------------------

  async webSocketMessage(socket: CfWebSocket, raw: string | ArrayBuffer) {
    const attachment = socket.deserializeAttachment() as
      | DeskAttachment
      | PhoneAttachment;
    const link = this.streams();
    if (attachment.kind === "phone") {
      const passed = link.fromPhone(
        attachment.s,
        typeof raw === "string" ? raw : new Uint8Array(raw),
      );
      if (passed === "too-large") socket.close(1009, "too large");
      else if (!passed) socket.close(1011, "gone");
      return;
    }
    if (typeof raw !== "string") {
      link.onDeskData(new Uint8Array(raw));
      return;
    }
    const message = decodeDeskMessage(raw);
    if (!message || link.onDeskMessage(message)) return;
    await this.onDeskControl(attachment.installId, message);
  }

  private async onDeskControl(installId: string, message: DeskMessage) {
    const directory = this.directory();
    switch (message.t) {
      case "pair.start": {
        const started = await call<{ code: string; expiresAt: number }>(
          directory,
          "/start",
          { installId, deskId: message.id },
        );
        this.control({
          t: "pair.started",
          id: message.id,
          code: started.code,
          expiresAt: new Date(started.expiresAt).toISOString(),
        });
        return;
      }
      case "pair.confirm":
        await call(directory, "/confirm", { installId, message });
        return;
      case "pair.refuse":
        await call(directory, "/refuse", {
          installId,
          pairingId: message.pairingId,
        });
        return;
      case "devices": {
        const { kept } = await call<{ kept: string[] }>(directory, "/sync", {
          installId,
          devices: message.devices,
        });
        const ids = new Set(kept);
        this.streams().drop((deviceId) => !ids.has(deviceId));
        return;
      }
      case "beat":
        // Only when auto-response is off (the stand-ins): answer it the same way.
        this.control({ t: "beat" });
        return;
    }
  }

  async webSocketClose(socket: CfWebSocket, code: number, reason: string) {
    const attachment = socket.deserializeAttachment() as
      | DeskAttachment
      | PhoneAttachment;
    if (attachment.kind === "phone") {
      this.streams().phoneClosed(attachment.s, code, reason);
      return;
    }
    // Only the current desktop's going matters; a replaced one is already gone.
    if (this.state.getWebSockets("desk").some((desk) => desk !== socket))
      return;
    this.link?.drop();
    this.link = null;
    for (const phone of this.state.getWebSockets("phone"))
      phone.close(1012, "gone");
    await call(this.directory(), "/desk", {
      installId: attachment.installId,
      connected: false,
    });
  }

  async webSocketError(socket: CfWebSocket) {
    await this.webSocketClose(socket, 1011, "error");
  }
}

function socketOf(socket: CfWebSocket) {
  return {
    send: (data: string | Uint8Array) => socket.send(data),
    close: (code: number, reason: string) => socket.close(code, reason),
  };
}
