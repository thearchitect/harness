// A pairing code exchanged at the hub (POST /pair) for this device's token: in the answer for the
// apps, as an HttpOnly cookie for a browser (`cookie`), which then never sees it.

export type PairingBody = { code: string; name: string; cookie: boolean };

export function pairingBody(code: string, name: string, cookie: boolean): PairingBody {
  return { code: code.trim(), name, cookie };
}

export async function redeemPairing(hub: string, body: PairingBody): Promise<{ device: string; token?: string }> {
  const base = hub.replace(/^ws/, "http").replace(/\/$/, "");
  const response = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
  const answer = (await response.json()) as { device: string; token?: string } | { error: { message: string } };
  if ("error" in answer) {
    throw new Error(answer.error.message);
  } else {
    return answer;
  }
}

/**
 * A pairing link or QR code's text: `https://<hub>/#pair=<code>` (the hub's address and the code),
 * or the app's own `harness://pair?hub=<address>&code=<code>`.
 */
export function parsePairingLink(text: string): { hub: string; code: string } | undefined {
  try {
    const url = new URL(text.trim());
    if (url.protocol === "harness:") {
      const hub = url.searchParams.get("hub");
      const code = url.searchParams.get("code");
      return hub !== null && code !== null ? { hub, code } : undefined;
    } else if (url.protocol === "https:" || url.protocol === "http:") {
      const code = new URLSearchParams(url.hash.slice(1)).get("pair");
      return code !== null ? { hub: url.origin, code } : undefined;
    } else {
      return undefined;
    }
  } catch {
    return undefined;
  }
}

/** The app's link for a pairing (a phone's browser hands it to the installed app). */
export function appPairingLink(hub: string, code: string): string {
  return `harness://pair?hub=${encodeURIComponent(hub)}&code=${encodeURIComponent(code)}`;
}
