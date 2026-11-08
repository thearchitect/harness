/**
 * Mini App requests carry Telegram's initData (`Authorization: tma <initData>`):
 * a query string signed with HMAC-SHA256 under the key
 * HMAC_SHA256(key "WebAppData", data bot token). A request is accepted when
 * the signature is valid and `auth_date` is at most MAX_AGE_MS old.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_AGE_MS = 24 * 60 * 60_000;

export function verifyInitData(initData: string, botToken: string, nowMs: number): { userId: number } | { problem: string } {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (hash === null || !/^[0-9a-f]{64}$/.test(hash)) {
    return { problem: "no signature" };
  }
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest();
  const authDate = Number(params.get("auth_date"));
  let user: { id?: unknown } | undefined;
  try {
    user = JSON.parse(params.get("user") ?? "null") as { id?: unknown } | undefined;
  } catch {
    user = undefined;
  }
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) {
    return { problem: "bad signature" };
  } else if (!Number.isFinite(authDate) || nowMs - authDate * 1000 > MAX_AGE_MS) {
    return { problem: "expired" };
  } else if (typeof user?.id !== "number") {
    return { problem: "no user" };
  } else {
    return { userId: user.id };
  }
}
