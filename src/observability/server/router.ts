import type { RouteHandler } from "./types.js";

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export interface MatchedRoute {
  handler: RouteHandler;
  params: Record<string, string>;
}

/**
 * Minimal method + path router (no framework). Patterns use `:name` segments,
 * each matching a single non-slash path segment; the captured value is
 * `decodeURIComponent`-ed so percent-encoded timeline keys (which contain `:`,
 * `!`, etc.) round-trip correctly.
 */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: RouteHandler): this {
    const paramNames: string[] = [];
    const source = path
      .split("/")
      .map((segment) => {
        if (segment.startsWith(":")) {
          paramNames.push(segment.slice(1));
          return "([^/]+)";
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    this.routes.push({
      method: method.toUpperCase(),
      pattern: new RegExp(`^${source}/?$`),
      paramNames,
      handler,
    });
    return this;
  }

  /** Returns the matching route, or null. */
  match(method: string, pathname: string): MatchedRoute | null {
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1]);
      });
      return { handler: route.handler, params };
    }
    return null;
  }

  /** True if the path matches a route under a different method (→ 405 vs 404). */
  pathExists(pathname: string): boolean {
    return this.routes.some((route) => route.pattern.test(pathname));
  }
}
