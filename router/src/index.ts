import { Hono, type Handler } from "hono";

/** Minimal fetcher shape so unit tests need no Cloudflare runtime types. */
export type ServiceFetcher = {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
};

export interface Env {
  API: ServiceFetcher;
}

type App = { Bindings: Env };

const forwardApi: Handler<App> = async (c) => {
  const url = new URL(c.req.raw.url);
  url.pathname = url.pathname.slice("/api".length) || "/";
  return c.env.API.fetch(new Request(url, c.req.raw));
};

const app = new Hono<App>();

app.all("/api", forwardApi).all("/api/*", forwardApi);
app.all("*", (c) => c.json({ error: "Not found" }, 404));

export { app };
export default app;
