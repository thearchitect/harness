// The browser's way back from a sign-in when the login runs on another machine: the callback port of
// the link is listened to here and the address goes to the hub as the step's answer; a login on this
// machine's own hub is left to its flow.

import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import type { InteractionRequest, LoginAnswer } from "#protocol/interactions.ts";
import { callbackPort, LoginCallback } from "./login-callback.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
    });
  });
}

function step(port: number, prompt: boolean): Extract<InteractionRequest, { kind: "login" }> {
  return {
    id: prompt ? "l2" : "l1",
    kind: "login",
    openedAt: 0,
    payload: {
      title: "Log in",
      url: `https://sso.example/authorize?redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/callback`)}`,
      progress: [],
      ...(prompt ? { prompt: { type: "manual_code" as const, message: "Paste" } } : {}),
    },
  };
}

test("the callback port of a sign-in link", () => {
  assert.deepEqual(callbackPort("https://a.example/x?redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback"), { port: 53692, host: "localhost" });
  assert.deepEqual(callbackPort("https://a.example/x?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback"), { port: 1455, host: "127.0.0.1" });
  assert.equal(callbackPort("https://a.example/x?redirect_uri=https%3A%2F%2Fexample.com%2Fcb"), undefined);
  assert.equal(callbackPort("https://a.example/x"), undefined);
  assert.equal(callbackPort("not a url"), undefined);
});

test("a remote hub's login: the browser's address reaches the step's field; a local one's is left alone", async () => {
  const port = await freePort();
  const answers: { id: string; answer: LoginAnswer }[] = [];
  const callback = new LoginCallback(
    (node) => node === "home",
    async (id, answer) => {
      answers.push({ id, answer });
    },
    () => undefined,
  );

  callback.follow(step(port, true), "home");
  await assert.rejects(fetch(`http://127.0.0.1:${port}/callback?code=x`), "nothing listens for a local node");

  callback.follow(step(port, false), "far");
  callback.follow(step(port, true), "far");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const response = await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=s`);
  assert.match(await response.text(), /Signed in/);
  assert.deepEqual(answers, [{ id: "l2", answer: { value: `http://127.0.0.1:${port}/callback?code=abc&state=s` } }]);
  callback.stop();
});
