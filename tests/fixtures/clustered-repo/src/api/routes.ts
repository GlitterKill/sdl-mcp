import { middleware } from "./middleware";
import { login } from "../auth/login.js";
import { query } from "../data/query.js";

export function routesApi(): string {
  middleware();
  wireRoutes();
  const a = loginhandler("api");
  const b = datahandler("api");
  return `${a}|${b}`;
}

function loginhandler(user: string): string {
  middleware();
  return login(user);
}

function datahandler(value: string): string {
  const result = query(value);
  wrapMiddleware();
  return result;
}

function wrapMiddleware(): void {
  middleware();
}

function wireRoutes(): void {
  middleware();
  loginhandler("wire");
  datahandler("wire");
}

function routesApiEntry(): string {
  return routesApi();
}
