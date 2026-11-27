// A pairing code exchanged at the hub (POST /pair) for this device's token (plan A28).

export async function redeemPairing(hub: string, code: string): Promise<{ device: string; token: string }> {
  const base = hub.replace(/^ws/, "http").replace(/\/$/, "");
  const response = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const body = (await response.json()) as { device: string; token: string } | { error: { message: string } };
  if ("error" in body) {
    throw new Error(body.error.message);
  } else {
    return body;
  }
}
