import { createHmac } from "node:crypto";

/**
 * Minimal Gitea REST client over the plugin's http.fetch (30s RPC ceiling).
 */
export class GiteaClient {
  constructor(
    private baseUrl: string,
    private token: string,
    private fetchFn: (url: string, init: RequestInit) => Promise<Response>,
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}/api/v1${path.startsWith("/") ? path : `/${path}`}`;
    const res = await this.fetchFn(url, {
      method,
      headers: {
        Authorization: `token ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const msg =
        parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : `HTTP ${res.status}`;
      throw new Error(`gitea ${method} ${path} failed: ${msg} (${res.status})`);
    }
    return parsed;
  }

  get(path: string) { return this.request("GET", path); }
  post(path: string, body?: unknown) { return this.request("POST", path, body); }
  patch(path: string, body?: unknown) { return this.request("PATCH", path, body); }
  put(path: string, body?: unknown) { return this.request("PUT", path, body); }
  delete(path: string) { return this.request("DELETE", path); }

  /** Verify X-Gitea-Signature (HMAC-SHA256 hex) against the raw body. */
  static verifySignature(rawBody: string, header: string | undefined, secret: string): boolean {
    if (!header) return false;
    const expected = createHmac("sha256", secret).update(rawBody, "utf-8").digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(header);
    if (a.length !== b.length) return false;
    return cryptoTimingSafeEqual(a, b);
  }

  /** Generic request exposed for the agent tool. */
  call(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.request(method, path, body);
  }
}

function cryptoTimingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
