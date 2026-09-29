import { Hono, type Handler } from "hono";

/** Minimal fetcher shape so unit tests need no Cloudflare runtime types. */
export type ServiceFetcher = {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
};

export interface Env {
  API: ServiceFetcher;
  DOCS_WORKER?: ServiceFetcher;
}

type App = { Bindings: Env };

const forwardApi: Handler<App> = async (c) => {
  const url = new URL(c.req.raw.url);
  url.pathname = url.pathname.slice("/api".length) || "/";
  return c.env.API.fetch(new Request(url, c.req.raw));
};

const DOCS_EXACT_PATHS = new Set([
  "/",
  "/install.sh",
  "/install.ps1",
  "/index.md",
  "/index.mdx",
  "/404",
  "/404.html",
  "/llms.txt",
  "/llms-full.txt",
  "/robots.txt",
  "/og.png",
  "/favicon.ico",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/apple-touch-icon.png",
  "/android-chrome-192x192.png",
  "/android-chrome-512x512.png",
  "/site.webmanifest",
  "/sitemap-0.xml",
  "/sitemap-index.xml",
]);

const DOCS_PREFIXES = ["/docs", "/og", "/_astro", "/_nimbus", "/pagefind", "/fonts"] as const;

function isDocsPath(pathname: string): boolean {
  if (DOCS_EXACT_PATHS.has(pathname)) {
    return true;
  }
  return DOCS_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

const forwardDocs: Handler<App> = async (c) => {
  const pathname = new URL(c.req.url).pathname;
  if (!isDocsPath(pathname)) {
    return c.text("I'm a teapot", 418);
  }
  const docs = c.env.DOCS_WORKER;
  if (docs === undefined) {
    return c.json({ error: "Not found" }, 404);
  }
  return docs.fetch(c.req.raw);
};

const app = new Hono<App>();

app.all("/api", forwardApi).all("/api/*", forwardApi);
app.all("*", forwardDocs);

export { app };
export default app;
