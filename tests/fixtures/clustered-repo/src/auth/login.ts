import { session } from "./session";
import { token } from "./token";

export function login(user: string): string {
  token(user);
  return session(user);
}

export function loginTokenPreview(user: string): string {
  return token(user);
}

function loginInternal(): string {
  return login("internal");
}

export function loginInternalEntry(): string {
  return loginInternal();
}
