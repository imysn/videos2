import { AppError } from "./errors.js";
export class Limiter {
  private entries = new Map<string, { count: number; until: number }>();
  check(key: string, max: number, windowMs: number, now = Date.now()) {
    if (this.entries.size > 10000)
      for (const [k, v] of this.entries)
        if (v.until < now) this.entries.delete(k);
    let value = this.entries.get(key);
    if (!value || value.until <= now) {
      value = { count: 0, until: now + windowMs };
      this.entries.set(key, value);
    }
    value.count++;
    if (value.count > max)
      throw new AppError(
        "RATE_LIMITED",
        429,
        "Demasiadas solicitudes. Espera un momento.",
      );
  }
}
