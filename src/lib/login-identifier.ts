import { z } from "./zod";
const email = z.email().max(254);
export function isLoginIdentifier(value: string) {
  return /^[a-zA-Z0-9_.]{3,30}$/.test(value) || email.safeParse(value).success;
}
