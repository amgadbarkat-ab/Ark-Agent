/**
 * The part of nodemailer (MIT, approved on #109) the Mailbox connector uses. nodemailer ships no
 * types, and Amgad's yes covered the three libraries only, so no @types package: just this.
 */
declare module "nodemailer" {
  type Address = string;
  export type MailOptions = {
    from: Address;
    to: Address[];
    cc?: Address[];
    subject: string;
    text: string;
  };
  export type SentInfo = { messageId?: string; message?: unknown };
  export type Transporter = {
    sendMail(options: MailOptions): Promise<SentInfo>;
    verify(): Promise<true>;
    close(): void;
  };
  export type TransportOptions =
    | { streamTransport: true; buffer: true }
    | {
        host: string;
        port: number;
        secure: boolean;
        requireTLS?: boolean;
        auth: { user: string; pass: string };
        connectionTimeout?: number;
        greetingTimeout?: number;
        socketTimeout?: number;
      };
  export function createTransport(options: TransportOptions): Transporter;
  const nodemailer: { createTransport: typeof createTransport };
  export default nodemailer;
}
