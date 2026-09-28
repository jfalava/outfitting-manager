import { describe, expect, test } from "vitest";

import { app, type Env, type ServiceFetcher } from "../src/index";

type Call = {
  url: string;
  method: string;
  body: string | undefined;
};

type Stub = ServiceFetcher & { calls: Call[] };

function stubFetcher(): Stub {
  const calls: Call[] = [];
  return {
    calls,
    async fetch(input: Request | string, init?: RequestInit) {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push({
        url: request.url,
        method: request.method,
        body:
          request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
      });
      return new Response("api", { status: 200 });
    },
  };
}

async function hit(path: string, env: Env, init?: RequestInit) {
  return app.fetch(new Request(`https://api.outfitting.jfa.dev${path}`, init), env);
}

describe("manager API router", () => {
  test("strips /api and preserves the request method and body", async () => {
    const API = stubFetcher();
    const response = await hit(
      "/api/lockfiles/machine/kind",
      { API },
      { method: "PUT", body: "snapshot", headers: { "content-type": "text/plain" } },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("api");
    expect(API.calls).toEqual([
      {
        url: "https://api.outfitting.jfa.dev/lockfiles/machine/kind",
        method: "PUT",
        body: "snapshot",
      },
    ]);
  });

  test("forwards the /api root as /", async () => {
    const API = stubFetcher();
    await hit("/api", { API });

    expect(API.calls[0]?.url).toBe("https://api.outfitting.jfa.dev/");
  });

  test("does not send non-API paths to the API worker", async () => {
    const API = stubFetcher();
    const response = await hit("/docs/cli", { API });

    expect(response.status).toBe(404);
    expect(API.calls).toEqual([]);
  });
});
