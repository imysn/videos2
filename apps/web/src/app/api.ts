export class ApiError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
export function csrfToken() {
  return csrf;
}
export async function api<T = unknown>(
  path: string,
  method = "GET",
  body?: unknown,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<T> {
  const response = await fetch("/api/v1" + path, {
    method,
    credentials: "same-origin",
    headers:
      method === "GET"
        ? {}
        : {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf,
            "Idempotency-Key": idempotencyKey,
          },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ code: "INTERNAL_ERROR" }));
    throw new ApiError(error.code);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export interface Profile {
  id: string;
  username: string;
  displayName: string;
  role: "OWNER" | "PARTNER";
  mustChangePassword: boolean;
  avatarAssetId: string | null;
  preferences: Record<string, unknown>;
  csrf?: string;
}
export interface Media {
  id: string;
  title: string;
  description: string;
  category: string | null;
  durationSeconds: number;
  contentGeneration: string;
  posterUrl: string | null;
  publicationState: string;
  sourceKind: string | null;
  health: string;
  preparation?:
    | import("../../../../packages/contracts/src/upload-pipeline").UploadPreparation
    | null;
  personalPosition: number;
  sharedPosition: number;
  pending: boolean;
  watched: boolean;
  subtitles?: { id: string; url: string; label: string; language: string }[];
  chapters?: { startSeconds: number; title: string }[];
  sprite?: {
    url: string;
    interval?: number;
    columns?: number;
    width?: number;
    height?: number;
  } | null;
}
export function clientId() {
  let id = sessionStorage.getItem("rave-client");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("rave-client", id);
  }
  return id;
}
export function time(seconds: number) {
  const n = Math.max(0, Math.floor(seconds || 0));
  return n >= 3600
    ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`
    : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}
