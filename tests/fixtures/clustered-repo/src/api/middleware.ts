import { routesApi } from "./routes";

export function middleware(): void {
  // no-op
}

export function middlewareRoutes(): string {
  routesApi();
  return "mw";
}
