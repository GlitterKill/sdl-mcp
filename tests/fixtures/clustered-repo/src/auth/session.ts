import { token } from "./token";

export function session(user: string): string {
  return token(user);
}

function sessionInternal(): string {
  return session("internal");
}

export function sessionInternalEntry(): string {
  return sessionInternal();
}
