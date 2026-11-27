// A browser's way back from a provider's sign-in, when the login runs on another machine (plan
// polish-3 C): the sign-in link names a callback on 127.0.0.1/localhost, which on this machine
// reaches nothing. While such a login step is shown, this TUI listens on the same port and sends
// the address the browser came back to on to the hub, as the answer of the step's field (pi's flows
// take a pasted redirect address there). A login on this machine's own hub needs none of it: its
// flow listens itself. Busy port: the operator pastes the address, as the step says.

import { createServer, type Server } from "node:http";
import type { InteractionRequest, LoginAnswer } from "#protocol/interactions.ts";

type LoginRequest = Extract<InteractionRequest, { kind: "login" }>;

/** The local port a sign-in link sends the browser back to, if it is one. */
export function callbackPort(url: string): { port: number; host: string } | undefined {
  try {
    const redirect = new URL(url).searchParams.get("redirect_uri");
    const target = redirect !== null ? new URL(redirect) : undefined;
    if (target !== undefined && (target.hostname === "127.0.0.1" || target.hostname === "localhost") && target.port !== "") {
      return { port: Number(target.port), host: target.hostname };
    } else {
      return undefined;
    }
  } catch {
    return undefined; // not a URL: nothing to listen for
  }
}

const PAGE = "<!doctype html><meta charset=utf-8><title>harness</title><p>Signed in. You can close this tab.</p>";

export class LoginCallback {
  private readonly isLocal: (node: string | undefined) => boolean;
  private readonly answer: (interactionId: string, answer: LoginAnswer) => Promise<void>;
  private readonly notify: (message: string) => void;
  private server: { port: number; server: Server } | undefined;
  /** The step whose field takes the address (the latest one with a line to enter). */
  private target: LoginRequest | undefined;

  constructor(isLocal: (node: string | undefined) => boolean, answer: (interactionId: string, answer: LoginAnswer) => Promise<void>, notify: (message: string) => void) {
    this.isLocal = isLocal;
    this.answer = answer;
    this.notify = notify;
  }

  /** A login step is shown: listen for its callback when its hub is elsewhere. */
  follow(request: LoginRequest, node: string | undefined): void {
    const url = request.payload.url;
    const callback = url !== undefined ? callbackPort(url) : undefined;
    if (this.isLocal(node) || callback === undefined) {
      this.stop(); // the node's own flow listens, or there is nothing to listen for
    } else {
      const prompt = request.payload.prompt;
      this.target = prompt !== undefined && prompt.type !== "select" ? request : undefined;
      if (this.server?.port === callback.port) {
        return; // listening already
      } else {
        this.stop();
        const server = createServer((incoming, response) => {
          const address = `http://${callback.host}:${callback.port}${incoming.url ?? "/"}`;
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(PAGE);
          const target = this.target;
          if (target !== undefined) {
            void this.answer(target.id, { value: address });
            this.stop();
          } else {
            this.notify("the browser came back before the login asked for it: paste the address it ended on");
          }
        });
        server.on("error", () => {
          this.notify(`port ${callback.port} is busy on this machine: paste the address the browser ends on`);
          this.server = undefined;
        });
        server.listen(callback.port, callback.host === "localhost" ? "127.0.0.1" : callback.host);
        this.server = { port: callback.port, server };
      }
    }
  }

  stop(): void {
    this.server?.server.close();
    this.server = undefined;
    this.target = undefined;
  }
}
