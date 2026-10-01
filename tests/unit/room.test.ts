import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  emptyRoom,
  expectedPosition,
  reduceRoom,
  clockOffset,
  correction,
  RoomError,
  type Context,
} from "../../packages/room-core/src/index.js";
import type {
  RoomAction,
  RoomSnapshot,
} from "../../packages/contracts/src/protocol.js";
import {
  commandSchema,
  readySchema,
  watched,
} from "../../packages/contracts/src/index.js";
const owner = randomUUID(),
  partner = randomUUID(),
  generation = randomUUID();
function state(): RoomSnapshot {
  return {
    ...emptyRoom(randomUUID(), randomUUID()),
    sessionId: randomUUID(),
    media: {
      mediaId: randomUUID(),
      sourceId: randomUUID(),
      contentGeneration: generation,
      title: "Fixture",
      durationSeconds: 120,
    },
    hostUserId: owner,
    hostEpoch: 1,
    phase: "paused",
    anchorPositionSeconds: 20,
    anchorServerTimeMs: 1000,
    expectedUserIds: [owner, partner],
    participants: [
      {
        userId: owner,
        displayName: "Jason",
        status: "present",
        expectedForPlayback: true,
        isHost: true,
      },
      {
        userId: partner,
        displayName: "Mi pareja",
        status: "present",
        expectedForPlayback: true,
        isHost: false,
      },
    ],
  };
}
function ctx(actor = owner): Context {
  return {
    now: 1000,
    barrierId: randomUUID(),
    actorUserId: actor,
    hostPresent: true,
    activeUserIds: [owner, partner],
  };
}
function action(s: RoomSnapshot, a: RoomAction, c = ctx()) {
  return reduceRoom(s, { type: "command", action: a }, c);
}
describe("Room reducer — transiciones autoritativas", () => {
  it("PLAY explícito después de ended vuelve a cero mediante una barrera nueva", () => {
    const previous = {
      ...state(),
      phase: "ended" as const,
      anchorPositionSeconds: 120,
    };
    const next = action(previous, { type: "PLAY" });
    expect(next.anchorPositionSeconds).toBe(0);
    expect(next.phase).toBe("preparing");
    expect(next.barrier).not.toBeNull();
    expect(previous.anchorPositionSeconds).toBe(120);
  });
  it("PLAY necesita a ambos y un inicio futuro después de READY", () => {
    const c = ctx(),
      s = action(state(), { type: "PLAY" }, c);
    expect(s.phase).toBe("preparing");
    const one = reduceRoom(
      s,
      { type: "ready", userId: owner, barrierId: c.barrierId },
      c,
    );
    expect(one.phase).toBe("preparing");
    const all = reduceRoom(
      one,
      { type: "ready", userId: partner, barrierId: c.barrierId },
      c,
    );
    expect(all.phase).toBe("playing");
    expect(all.anchorServerTimeMs).toBe(1300);
    expect(expectedPosition(all, 1200)).toBe(20);
    expect(expectedPosition(all, 2300)).toBe(21);
  });
  it("READY antiguo y de usuario no esperado no libera barrera", () => {
    const s = action(state(), { type: "PLAY" });
    expect(
      reduceRoom(
        s,
        { type: "ready", userId: owner, barrierId: randomUUID() },
        ctx(),
      ),
    ).toEqual(s);
    expect(
      reduceRoom(
        s,
        {
          type: "ready",
          userId: randomUUID(),
          barrierId: s.barrier!.barrierId,
        },
        ctx(),
      ),
    ).toEqual(s);
  });
  it.each(["paused", "playing"] as const)(
    "SEEK preserva intención %s",
    (phase) => {
      const s = { ...state(), phase, desiredPlayback: phase };
      const n = action(s, { type: "SEEK", positionSeconds: 87 });
      expect(n.anchorPositionSeconds).toBe(87);
      expect(n.desiredPlayback).toBe(phase);
      expect(n.phase).toBe(phase === "playing" ? "preparing" : "paused");
      expect(n.media?.contentGeneration).toBe(generation);
    },
  );
  it.each([-1, 121, Infinity, NaN])("rechaza seek fuera de duración: %s", (n) =>
    expect(() => action(state(), { type: "SEEK", positionSeconds: n })).toThrow(
      "INVALID_RANGE",
    ),
  );
  it("PAUSE durante buffering cancela la reanudación automática", () => {
    const c = ctx(),
      s = action(state(), { type: "PLAY" }, c),
      blocked = reduceRoom(
        s,
        { type: "block", userId: partner, reason: "BUFFERING" },
        c,
      ),
      paused = action(blocked, { type: "PAUSE" }, c);
    expect(paused.desiredPlayback).toBe("paused");
    expect(paused.barrier).toBeNull();
    expect(
      reduceRoom(
        paused,
        { type: "ready", userId: partner, barrierId: c.barrierId },
        c,
      ),
    ).toEqual(paused);
  });
  it("buffering bloquea una vez y no cambia la intención", () => {
    const s = {
        ...state(),
        phase: "playing" as const,
        desiredPlayback: "playing" as const,
      },
      c = ctx();
    const n = reduceRoom(
      s,
      { type: "block", userId: partner, reason: "BUFFERING" },
      c,
    );
    expect(n.phase).toBe("blocked");
    expect(n.desiredPlayback).toBe("playing");
    expect(
      reduceRoom(n, { type: "block", userId: partner, reason: "BUFFERING" }, c),
    ).toEqual(n);
  });
  it("sin Esperarnos y para excluido no bloquea", () => {
    const s = {
      ...state(),
      phase: "playing" as const,
      desiredPlayback: "playing" as const,
    };
    expect(
      reduceRoom(
        { ...s, waitTogether: false },
        { type: "block", userId: partner, reason: "BUFFERING" },
        ctx(),
      ).phase,
    ).toBe("playing");
    expect(
      reduceRoom(
        { ...s, temporarilyExcludedUserIds: [partner] },
        { type: "block", userId: partner, reason: "BUFFERING" },
        ctx(),
      ).phase,
    ).toBe("playing");
  });
  it("continúa sin ausente y vuelve a preparar al entrar tarde sin volver a cero", () => {
    let s = state();
    s.participants[1].status = "away";
    s = action(s, { type: "CONTINUE_WITHOUT_WAITING" });
    expect(s.temporarilyExcludedUserIds).toEqual([partner]);
    s = reduceRoom(
      s,
      { type: "ready", userId: owner, barrierId: s.barrier!.barrierId },
      ctx(),
    );
    const n = reduceRoom(
      s,
      { type: "join", userId: partner },
      { ...ctx(), now: 10300 },
    );
    expect(n.anchorPositionSeconds).toBe(29);
    expect(n.temporarilyExcludedUserIds).toEqual([]);
    expect(n.phase).toBe("preparing");
  });
  it("SET_RATE materializa posición antes de aplicar velocidad", () => {
    const s = {
      ...state(),
      phase: "playing" as const,
      desiredPlayback: "playing" as const,
    };
    const n = action(
      s,
      { type: "SET_RATE", rate: 1.5 },
      { ...ctx(), now: 3000 },
    );
    expect(n.anchorPositionSeconds).toBe(22);
    expect(expectedPosition(n, 5000)).toBe(25);
    expect(() => action(s, { type: "SET_RATE", rate: 3 as 1 })).toThrow();
  });
  it("transferencia conserva reproducción y aumenta epoch", () => {
    const s = {
      ...state(),
      phase: "playing" as const,
      desiredPlayback: "playing" as const,
    };
    const n = action(s, { type: "TRANSFER_HOST", targetUserId: partner });
    expect(n.hostUserId).toBe(partner);
    expect(n.hostEpoch).toBe(2);
    expect(n.phase).toBe("playing");
    expect(() => action(n, { type: "PAUSE" })).toThrow("NOT_HOST");
  });
  it("no transfiere a ausente o al mismo anfitrión", () => {
    const s = state();
    s.participants[1].status = "away";
    expect(() =>
      action(s, { type: "TRANSFER_HOST", targetUserId: partner }),
    ).toThrow("PARTNER_NOT_READY");
    expect(() =>
      action(s, { type: "TRANSFER_HOST", targetUserId: owner }),
    ).toThrow("PARTNER_NOT_READY");
  });
  it("reclamación requiere ausencia; el retorno no recupera mando", () => {
    const s = state();
    expect(() => action(s, { type: "CLAIM_HOST" }, ctx(partner))).toThrow(
      "HOST_STILL_PRESENT",
    );
    const n = action(
      s,
      { type: "CLAIM_HOST" },
      { ...ctx(partner), hostPresent: false },
    );
    expect(n.hostUserId).toBe(partner);
    expect(
      reduceRoom(n, { type: "join", userId: owner }, ctx()).hostUserId,
    ).toBe(partner);
  });
  it("CHANGE_MEDIA anula barreras y carga pausado", () => {
    const s = action(state(), { type: "PLAY" }),
      media = {
        ...s.media!,
        mediaId: randomUUID(),
        contentGeneration: randomUUID(),
      };
    const n = action(
      s,
      { type: "CHANGE_MEDIA", mediaId: media.mediaId },
      { ...ctx(), media },
    );
    expect(n.media).toEqual(media);
    expect(n.phase).toBe("paused");
    expect(n.anchorPositionSeconds).toBe(0);
    expect(n.barrier).toBeNull();
    expect(() =>
      action(s, { type: "CHANGE_MEDIA", mediaId: media.mediaId }),
    ).toThrow("MEDIA_UNAVAILABLE");
  });
  it("retirada bloquea y conserva posición", () => {
    const s = {
      ...state(),
      phase: "playing" as const,
      desiredPlayback: "playing" as const,
    };
    const n = reduceRoom(s, { type: "unavailable" }, { ...ctx(), now: 3000 });
    expect(n.anchorPositionSeconds).toBe(22);
    expect(n.blockReason).toBe("MEDIA_UNAVAILABLE");
    expect(n.desiredPlayback).toBe("paused");
  });
  it("reinicio cambia reloj y mantiene checkpoint sin avanzar por caída", () => {
    const s = {
      ...state(),
      phase: "playing" as const,
      desiredPlayback: "playing" as const,
    };
    const id = randomUUID();
    const n = reduceRoom(
      s,
      { type: "restart", serverInstanceId: id },
      { ...ctx(), now: 10000000 },
    );
    expect(n.phase).toBe("paused");
    expect(n.anchorPositionSeconds).toBe(20);
    expect(n.serverInstanceId).toBe(id);
    expect(n.participants.every((p) => p.status === "away")).toBe(true);
  });
  it("ended solo se acepta al final; cerrar deja sala vacía", () => {
    const s = state();
    expect(reduceRoom(s, { type: "ended" }, ctx())).toEqual(s);
    const playing = {
      ...s,
      phase: "playing" as const,
      desiredPlayback: "playing" as const,
      anchorPositionSeconds: 120,
    };
    const ended = reduceRoom(playing, { type: "ended" }, ctx());
    expect(ended.phase).toBe("ended");
    expect(ended.desiredPlayback).toBe("paused");
    const empty = action(ended, { type: "END_SESSION" });
    expect(empty.sessionId).toBeNull();
    expect(empty.media).toBeNull();
    expect(() => action(empty, { type: "PLAY" })).toThrow(RoomError);
  });
  it("desactivar espera crea barrera solo para presentes", () => {
    const s = state();
    s.participants[1].status = "away";
    const n = action(action(s, { type: "PLAY" }), {
      type: "SET_WAIT_TOGETHER",
      enabled: false,
    });
    expect(n.barrier?.requiredUserIds).toEqual([owner]);
  });
  it("no anfitrión nunca decide transporte", () => {
    for (const a of [
      { type: "PLAY" },
      { type: "PAUSE" },
      { type: "SEEK", positionSeconds: 40 },
      { type: "SET_RATE", rate: 1.5 },
      { type: "END_SESSION" },
    ] as RoomAction[])
      expect(() => action(state(), a, ctx(partner))).toThrow("NOT_HOST");
  });
});
describe("Reloj, deriva y validación estricta", () => {
  it("reloj usa mediana de menor RTT y descarta inválidos", () => {
    expect(
      clockOffset([
        {
          clientSend: 0,
          clientReceive: 20,
          serverReceive: 1010,
          serverSend: 1010,
        },
        {
          clientSend: 100,
          clientReceive: 120,
          serverReceive: 1110,
          serverSend: 1110,
        },
        {
          clientSend: 200,
          clientReceive: 220,
          serverReceive: 1210,
          serverSend: 1210,
        },
        {
          clientSend: 300,
          clientReceive: 30000,
          serverReceive: 9500,
          serverSend: 9500,
        },
      ]),
    ).toBe(1000);
    expect(() => clockOffset([])).toThrow();
  });
  it.each([0, 0.1, -0.1])("no corrige error pequeño %s", (e) =>
    expect(correction(e, 1.5)).toEqual({ seek: false, rate: 1.5 }),
  );
  it.each([0.4, -0.4])("corrección suave acotada %s", (e) => {
    const c = correction(e, 1);
    expect(c.seek).toBe(false);
    expect(c.rate).toBeGreaterThanOrEqual(0.95);
    expect(c.rate).toBeLessThanOrEqual(1.05);
  });
  it.each([1, -1])("desfase grande requiere seek %s", (e) =>
    expect(correction(e, 1)).toEqual({ seek: true, rate: 1 }),
  );
  it("rechaza campos extra, userId falsificado y números no finitos", () => {
    const s = state(),
      b = {
        protocolVersion: 1,
        commandId: randomUUID(),
        roomId: s.roomId,
        sessionId: s.sessionId,
        leaseId: "x".repeat(43),
        expectedRevision: 0,
        expectedHostEpoch: 1,
        contentGeneration: generation,
        action: { type: "PLAY" },
      };
    expect(commandSchema.safeParse(b).success).toBe(true);
    expect(commandSchema.safeParse({ ...b, userId: owner }).success).toBe(
      false,
    );
    expect(
      commandSchema.safeParse({
        ...b,
        action: { type: "SEEK", positionSeconds: Infinity },
      }).success,
    ).toBe(false);
    expect(readySchema.safeParse({}).success).toBe(false);
  });
  it("vídeo corto no se marca visto al comenzar", () => {
    expect(watched(1, 90)).toBe(false);
    expect(watched(86, 90)).toBe(true);
    expect(watched(1080, 1200)).toBe(true);
  });
});
