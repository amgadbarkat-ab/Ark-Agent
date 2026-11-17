/**
 * The relay's alert email (#109, v0.1.47) against a stand-in mail server on this machine (no TLS in
 * the test only). Nothing leaves this machine.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { messageText, sendMail } from "./smtp";

const said: string[] = [];
let failRcpt = false;
const server = Bun.listen<{ data: boolean }>({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    open(socket) {
      socket.data = { data: false };
      socket.write("220 test ready\r\n");
    },
    data(socket, chunk) {
      for (const line of new TextDecoder().decode(chunk).split("\r\n")) {
        if (line === "" && !socket.data.data) continue;
        said.push(line);
        if (socket.data.data) {
          if (line === ".") {
            socket.data.data = false;
            socket.write("250 queued\r\n");
          }
          continue;
        }
        if (line.startsWith("EHLO"))
          socket.write("250-test\r\n250 AUTH LOGIN\r\n");
        else if (line === "AUTH LOGIN") socket.write("334 VXNlcm5hbWU6\r\n");
        else if (said.at(-2) === "AUTH LOGIN")
          socket.write("334 UGFzc3dvcmQ6\r\n");
        else if (said.at(-3) === "AUTH LOGIN") socket.write("235 ok\r\n");
        else if (line.startsWith("MAIL FROM")) socket.write("250 ok\r\n");
        else if (line.startsWith("RCPT TO"))
          socket.write(failRcpt ? "550 no such user\r\n" : "250 ok\r\n");
        else if (line === "DATA") {
          socket.data.data = true;
          socket.write("354 go\r\n");
        } else if (line === "QUIT") socket.write("221 bye\r\n");
      }
    },
  },
});
afterAll(() => server.stop(true));

const config = {
  host: "127.0.0.1",
  port: server.port,
  user: "alerts@example.test",
  password: "mailbox-password",
  from: "alerts@example.test",
  to: ["one@example.test", "two@example.test"],
  tls: false,
  timeoutMs: 2000,
};

describe("the relay's alert email", () => {
  test("logs in, writes to every address, and sends one UTF-8 message", async () => {
    said.length = 0;
    await sendMail(
      config,
      "Ειδοποίηση: blackark.uk",
      "Το blackark.uk δεν απαντά.",
    );
    expect(said).toContain("AUTH LOGIN");
    expect(said).toContain(
      Buffer.from("alerts@example.test").toString("base64"),
    );
    expect(said).toContain("MAIL FROM:<alerts@example.test>");
    expect(said).toContain("RCPT TO:<one@example.test>");
    expect(said).toContain("RCPT TO:<two@example.test>");
    // The body: after the blank line that ends the headers, up to the end-of-data line.
    const start = said.indexOf("Content-Transfer-Encoding: base64") + 2;
    const encoded = said.slice(start, said.indexOf(".", start)).join("");
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(
      "Το blackark.uk δεν απαντά.",
    );
    expect(said).toContain(
      `Subject: =?UTF-8?B?${Buffer.from("Ειδοποίηση: blackark.uk").toString("base64")}?=`,
    );
  });

  test("a refused address is an error, not a silent success", async () => {
    failRcpt = true;
    await expect(sendMail(config, "x", "y")).rejects.toThrow("550");
    failRcpt = false;
  });

  test("refuses something that is not an email address", async () => {
    await expect(
      sendMail({ ...config, to: ["not an address"] }, "x", "y"),
    ).rejects.toThrow("not an email address");
  });

  test("the message ends with the end-of-data line", () => {
    expect(messageText(config, "s", "b")).toEndWith("\r\n.\r\n");
  });
});
