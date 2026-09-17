import { lookupOrderResponse, submitCheckout } from "./lib/browser-api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function patchFetch(): void {
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = (init?.method || (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET") || "GET").toUpperCase();
    const path = url.replace(/^https?:\/\/[^/]+/, "");

    if (method === "POST" && path.startsWith("/api/checkout")) {
      const raw = typeof init?.body === "string" ? init.body : "{}";
      const payload = JSON.parse(raw);
      const result = submitCheckout(payload);
      return jsonResponse(result.success ? 201 : 400, result);
    }

    const orderMatch = path.match(/^\/api\/orders\/([^/?#]+)/);
    if (method === "GET" && orderMatch) {
      const looked = lookupOrderResponse(decodeURIComponent(orderMatch[1]));
      const body = await looked.json();
      return jsonResponse(looked.status, body);
    }

    return original(input, init);
  };
}
