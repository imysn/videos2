import { classes } from "../../styles/classes";
import { ui } from "../../i18n/es";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { io, type Socket } from "socket.io-client";
import type {
  RoomSnapshot,
  RoomAction,
  RoomCommand,
  CommandAck,
  PlaybackDescriptor,
  ChatMessage,
} from "../../../../../packages/contracts/src/protocol";
import { api, clientId, ApiError, type Media } from "../../app/api";
import { useAuth } from "../../app/auth";
import { SyncController, emitAck } from "../../player/sync-controller";
import { Player } from "../../player/Player";
import { Notice, Empty, Confirm } from "../../components/common";
interface Message extends ChatMessage {
  displayName: string;
}
export function RoomPage() {
  const { user } = useAuth(),
    [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null),
    [data, setData] = useState<{
      media: Media;
      descriptor: PlaybackDescriptor;
    } | null>(null),
    [messages, setMessages] = useState<Message[]>([]),
    [text, setText] = useState(""),
    [typing, setTyping] = useState(""),
    [online, setOnline] = useState(false),
    [active, setActive] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(),
    [notice, setNotice] = useState(""),
    [leaseConflict, setLeaseConflict] = useState(false);
  const pendingMessage = useRef<{
      protocolVersion: 1;
      roomId: string;
      clientMessageId: string;
      body: string;
    } | null>(null),
    messageSending = useRef(false),
    lastTyping = useRef(0);
  const sock = useRef<Socket | null>(null),
    controller = useRef<SyncController | null>(null),
    lease = useRef(""),
    state = useRef<RoomSnapshot | null>(null),
    mediaKey = useRef(""),
    requestGeneration = useRef(0),
    commandPending = useRef(false),
    stopped = useRef(false);
  const receive = (s: RoomSnapshot) => {
    const old = state.current;
    if (
      old &&
      old.serverInstanceId === s.serverInstanceId &&
      old.revision > s.revision
    )
      return;
    if (
      old?.hostUserId !== user?.id &&
      s.hostUserId === user?.id &&
      old?.sessionId
    )
      setNotice("Has recibido el control");
    state.current = s;
    setSnapshot(s);
    controller.current?.update(s);
    const key = s.media
      ? `${s.media.sourceId}:${s.media.contentGeneration}`
      : "";
    if (mediaKey.current !== key) {
      mediaKey.current = key;
      setData(null);
      const gen = ++requestGeneration.current;
      if (s.media) {
        void Promise.all([
          api<Media>(`/media/${s.media.mediaId}`),
          api<PlaybackDescriptor>("/room/playback/resolve", "POST", {
            leaseId: lease.current,
            contentGeneration: s.media.contentGeneration,
          }),
        ])
          .then(([media, descriptor]) => {
            if (gen === requestGeneration.current && !stopped.current)
              setData({ media, descriptor });
          })
          .catch((e) => {
            if (gen === requestGeneration.current) setError(e);
          });
      }
    }
  };
  const join = async (takeover = false) => {
    const s = await api<RoomSnapshot>("/room");
    let ownLease = lease.current;
    if (takeover) {
      const result = await api<{ ownLeaseId: string }>("/room/lease", "POST", {
        clientInstanceId: clientId(),
        takeover: true,
      });
      ownLease = result.ownLeaseId;
      lease.current = ownLease;
    }
    const result = await emitAck<{
      snapshot: RoomSnapshot;
      ownLeaseId: string;
    }>(sock.current!, "room:join", {
      protocolVersion: 1,
      roomId: s.roomId,
      clientInstanceId: clientId(),
      ...(ownLease ? { leaseId: ownLease } : {}),
    });
    lease.current = result.ownLeaseId;
    await controller.current!.calibrate();
    mediaKey.current = "";
    receive(result.snapshot);
    setOnline(true);
    setLeaseConflict(false);
    setError(undefined);
  };
  useEffect(() => {
    stopped.current = false;
    const socket = io({
      autoConnect: false,
      transports: ["websocket"],
      reconnection: true,
      timeout: 3000,
      reconnectionDelay: 500,
      reconnectionDelayMax: 1500,
    });
    sock.current = socket;
    const sync = new SyncController(
      socket,
      () => lease.current,
      setError,
      () => setActive(false),
      user?.id,
    );
    controller.current = sync;
    socket.on("connect", () => {
      void join().catch((e) => {
        setLeaseConflict(String(e).includes("DEVICE_ACTIVE"));
        setError(e);
      });
    });
    socket.on("disconnect", () => {
      setOnline(false);
      sync.disconnected();
    });
    socket.on("connect_error", () =>
      setError(new Error("Reconectando. Comprueba tu sesión.")),
    );
    socket.on("room:snapshot", receive);
    socket.on("room:lease-revoked", () => {
      setOnline(false);
      setLeaseConflict(true);
      sync.disconnected();
      setError(new Error("Esta cuenta ya está viendo en otro dispositivo."));
    });
    socket.on("room:notice", (n) => {
      if (n.code === "CONTROL_REQUESTED")
        setNotice("Tu acompañante pide el control");
    });
    const merge = (rows: Message[]) =>
      setMessages((old) => {
        const map = new Map(old.map((m) => [m.id, m]));
        for (const m of rows) map.set(m.id, m);
        return [...map.values()].sort((a, b) =>
          BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1,
        );
      });
    socket.on("chat:message", (m: Message) => merge([m]));
    socket.on("chat:deleted", ({ id }: { id: string }) =>
      setMessages((old) =>
        old.map((m) => (m.id === id ? { ...m, body: null } : m)),
      ),
    );
    socket.on("chat:cleared", () => setMessages([]));
    let typingTimer: ReturnType<typeof setTimeout> | undefined;
    socket.on(
      "chat:typing",
      ({ userId, typing: writing }: { userId: string; typing: boolean }) => {
        if (userId === user?.id) return;
        if (typingTimer) clearTimeout(typingTimer);
        setTyping(writing ? "Tu acompañante está escribiendo…" : "");
        typingTimer = setTimeout(() => setTyping(""), 3000);
      },
    );
    socket.on("connect", () => {
      void api<Message[]>("/room/chat").then(merge).catch(setError);
    });
    socket.connect();
    const heartbeat = setInterval(() => {
      const s = state.current;
      if (s && socket.connected && lease.current)
        void emitAck<{ snapshot: RoomSnapshot }>(socket, "room:heartbeat", {
          protocolVersion: 1,
          roomId: s.roomId,
          sessionId: s.sessionId,
          leaseId: lease.current,
        })
          .then((r) => receive(r.snapshot))
          .catch((e) => {
            setOnline(false);
            sync.disconnected();
            setError(e);
          });
    }, 5000);
    const visible = () => {
      if (document.visibilityState === "visible" && socket.connected) {
        void emitAck<RoomSnapshot>(socket, "room:resync", {
          protocolVersion: 1,
          roomId: state.current?.roomId,
        })
          .then(receive)
          .then(() => sync.calibrate())
          .catch(setError);
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped.current = true;
      requestGeneration.current++;
      clearInterval(heartbeat);
      if (typingTimer) clearTimeout(typingTimer);
      document.removeEventListener("visibilitychange", visible);
      const s = state.current;
      if (s && socket.connected)
        socket.emit("room:leave", {
          protocolVersion: 1,
          roomId: s.roomId,
          sessionId: s.sessionId,
          leaseId: lease.current,
        });
      sync.destroy();
      socket.disconnect();
      sock.current = null;
    };
  }, [user?.id]);
  const command = async (action: RoomAction) => {
    const s = state.current,
      socket = sock.current;
    if (
      !s?.sessionId ||
      !s.media ||
      !socket?.connected ||
      !online ||
      commandPending.current
    )
      return;
    commandPending.current = true;
    setPending(true);
    setError(undefined);
    const body: RoomCommand = {
      protocolVersion: 1,
      commandId: crypto.randomUUID(),
      roomId: s.roomId,
      sessionId: s.sessionId,
      leaseId: lease.current,
      expectedRevision: s.revision,
      expectedHostEpoch: s.hostEpoch,
      contentGeneration: s.media.contentGeneration,
      action,
    };
    try {
      let ack: CommandAck | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!socket.connected || state.current?.sessionId !== body.sessionId)
          throw new Error("Reconectando");
        try {
          ack = await new Promise<CommandAck>((resolve, reject) =>
            socket
              .timeout(3000)
              .emit("room:command", body, (e: Error | null, a: CommandAck) =>
                e ? reject(e) : resolve(a),
              ),
          );
          break;
        } catch (e) {
          if (attempt === 2) throw e;
        }
      }
      if (ack?.snapshot) receive(ack.snapshot);
      if (!ack?.accepted) throw new ApiError(ack?.code ?? "INTERNAL_ERROR");
    } catch (e) {
      setError(e);
    } finally {
      commandPending.current = false;
      setPending(false);
    }
  };
  const host = snapshot?.hostUserId === user?.id,
    other = snapshot?.participants.find((p) => p.userId !== user?.id),
    phase = snapshot?.phase;
  return (
    <>
      <div className={classes("heading")}>
        <div>
          <p className={classes("eyebrow")}>
            {ui.juntos_a_vuestro_ritmo_07a0f9}
          </p>
          <h1>{ui.nuestra_sala_d005df}</h1>
        </div>
        <Link to="/">{ui.elegir_video_b11ca4}</Link>
      </div>
      <Notice error={error} />
      {notice && <p role="status">{notice}</p>}
      {leaseConflict && (
        <button onClick={() => void join(true).catch(setError)}>
          {ui.usar_este_dispositivo_a58dbc}
        </button>
      )}
      <div className={classes("roomLayout")}>
        <section>
          <div className={classes("roomStatus")}>
            <strong>
              {host
                ? "Tú controlas"
                : `Controla ${snapshot?.participants.find((p) => p.isHost)?.displayName ?? "—"}`}
            </strong>
            <span>{online ? "Conectado" : "Reconectando"}</span>
            <span>
              {other?.displayName}
              {ui._45822f}
              {other?.status ?? "fuera"}
            </span>
          </div>
          {data ? (
            <>
              <h2>{data.media.title}</h2>
              <Player
                desiredPlayback={snapshot?.desiredPlayback}
                diagnostics={() => controller.current?.diagnostics() ?? {}}
                descriptor={data.descriptor}
                media={data.media}
                room
                canControl={host && online && !pending}
                onEngine={(e) => controller.current?.attach(e)}
                onIntent={(type, value) =>
                  void command(
                    type === "SEEK"
                      ? { type, positionSeconds: value! }
                      : type === "SET_RATE"
                        ? { type, rate: value as 1 }
                        : { type },
                  )
                }
              />
              {!active && (
                <button
                  className={classes("primary")}
                  onClick={() =>
                    void controller.current
                      ?.activate()
                      .then(() =>
                        setActive(controller.current?.activated ?? false),
                      )
                      .catch(setError)
                  }
                >
                  {ui.pulsa_para_activar_la_reproduccion_3df08d}
                </button>
              )}
            </>
          ) : (
            <Empty>
              <p>
                {snapshot?.media
                  ? "Cargando el vídeo…"
                  : "La sala está vacía. Elige un vídeo de vuestra biblioteca."}
              </p>
            </Empty>
          )}
          <p role="status">
            {phase === "blocked" || phase === "preparing"
              ? snapshot?.blockReason === "BUFFERING"
                ? "Está cargando el vídeo"
                : "Esperando a tu acompañante"
              : phase === "ended"
                ? "El vídeo ha terminado"
                : phase === "paused"
                  ? "En pausa"
                  : ""}
          </p>
          <div className={classes("actions")}>
            {snapshot?.blockReason === "MEDIA_UNAVAILABLE" && (
              <p>
                {ui.revisa_la_ficha_o_elige_b011ec}{" "}
                <button
                  disabled={!online}
                  onClick={() => {
                    mediaKey.current = "";
                    if (state.current) receive(state.current);
                  }}
                >
                  {ui.reintentar_fuente_e30885}
                </button>
              </p>
            )}
            {host ? (
              <>
                <label className={classes("check")}>
                  <input
                    type="checkbox"
                    checked={snapshot?.waitTogether ?? true}
                    disabled={!online || pending}
                    onChange={(e) =>
                      void command({
                        type: "SET_WAIT_TOGETHER",
                        enabled: e.target.checked,
                      })
                    }
                  />
                  {ui.esperarnos_3b95c9}
                </label>
                <button
                  disabled={!online || pending}
                  onClick={() =>
                    void command({ type: "CONTINUE_WITHOUT_WAITING" })
                  }
                >
                  {ui.continuar_sin_esperar_e7b8ff}
                </button>
                <button
                  disabled={
                    !other || other.status === "away" || !online || pending
                  }
                  onClick={() =>
                    void command({
                      type: "TRANSFER_HOST",
                      targetUserId: other!.userId,
                    })
                  }
                >
                  {ui.pasar_el_control_7ccd2c}
                </button>
                <Confirm
                  label={ui.cerrar_sesion_compartida_c50dc4}
                  title={ui.cerrar_la_sesion_de_video_354772}
                  onConfirm={() => command({ type: "END_SESSION" })}
                >
                  {ui.se_guardara_vuestro_progreso_el_b25639}
                </Confirm>
                <ChangeMedia
                  onSelect={(id) =>
                    command({ type: "CHANGE_MEDIA", mediaId: id })
                  }
                />
              </>
            ) : (
              <>
                <button
                  disabled={!online}
                  onClick={() => {
                    const s = state.current;
                    if (s)
                      void emitAck(sock.current!, "room:request-control", {
                        protocolVersion: 1,
                        roomId: s.roomId,
                        sessionId: s.sessionId,
                        leaseId: lease.current,
                      }).catch(setError);
                  }}
                >
                  {ui.pedir_el_control_942882}
                </button>
                <button
                  disabled={!online}
                  onClick={() => void command({ type: "CLAIM_HOST" })}
                >
                  {ui.tomar_el_control_si_esta_5899bf}
                </button>
              </>
            )}
          </div>
        </section>
        <aside className={classes("chat")}>
          <h2>{ui.vuestro_chat_67c6e9}</h2>
          {messages.length >= 50 && (
            <button
              onClick={() =>
                void api<Message[]>(`/room/chat?before=${messages[0].sequence}`)
                  .then((rows) => setMessages((old) => [...rows, ...old]))
                  .catch(setError)
              }
            >
              {ui.mensajes_anteriores_b5fb18}
            </button>
          )}
          <ol aria-live="polite">
            {messages.map((m) => (
              <li key={m.id}>
                <strong>{m.displayName}</strong>
                <time dateTime={m.createdAt}>
                  {new Date(m.createdAt).toLocaleTimeString("es", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                <p>{m.body ?? "Mensaje eliminado"}</p>
                {m.body &&
                  (m.senderId === user?.id || user?.role === "OWNER") && (
                    <button
                      className={classes("small")}
                      aria-label={ui.borrar_mensaje_752de0}
                      onClick={() =>
                        void api(`/room/chat/${m.id}`, "DELETE").catch(setError)
                      }
                    >
                      {ui.borrar_d50a3d}
                    </button>
                  )}
              </li>
            ))}
          </ol>
          <p role="status">{typing}</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim() || !snapshot) return;
              if (messageSending.current) return;
              const body =
                pendingMessage.current?.body === text
                  ? pendingMessage.current
                  : ({
                      protocolVersion: 1,
                      roomId: snapshot.roomId,
                      clientMessageId: crypto.randomUUID(),
                      body: text,
                    } as const);
              pendingMessage.current = body;
              messageSending.current = true;
              void (async () => {
                for (let attempt = 0; attempt < 3; attempt++) {
                  try {
                    await emitAck(sock.current!, "chat:send", body);
                    pendingMessage.current = null;
                    setText((current) =>
                      current === body.body ? "" : current,
                    );
                    return;
                  } catch (error) {
                    if (attempt === 2 || !sock.current?.connected) throw error;
                  }
                }
              })()
                .catch(setError)
                .finally(() => {
                  messageSending.current = false;
                });
            }}
          >
            <label>
              {ui.mensaje_d2af31}
              <textarea
                rows={2}
                maxLength={2000}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  if (
                    snapshot &&
                    sock.current?.connected &&
                    performance.now() - lastTyping.current >= 1000
                  ) {
                    lastTyping.current = performance.now();
                    sock.current.volatile.emit("chat:typing", {
                      protocolVersion: 1,
                      roomId: snapshot.roomId,
                      typing: true,
                    });
                  }
                }}
              />
            </label>
            <button disabled={!online || !text.trim()}>
              {ui.enviar_e1d12d}
            </button>
          </form>
        </aside>
      </div>
    </>
  );
}
function ChangeMedia({
  onSelect,
}: {
  onSelect: (id: string) => Promise<void>;
}) {
  const [items, setItems] = useState<Media[]>([]),
    [chosen, setChosen] = useState("");
  useEffect(() => {
    void api<{ items: Media[] }>("/library").then((r) => setItems(r.items));
  }, []);
  return (
    <>
      <label>
        {ui.cambiar_video_f0c92a}
        <select value={chosen} onChange={(e) => setChosen(e.target.value)}>
          <option value="">{ui.elige_un_video_daa09d}</option>
          {items.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title}
            </option>
          ))}
        </select>
      </label>
      {chosen && (
        <Confirm
          label={ui.cambiar_video_f0c92a}
          title={ui.cambiar_el_video_de_la_21c26c}
          onConfirm={() => onSelect(chosen)}
        >
          {ui.el_progreso_actual_se_guardara_e257af}
        </Confirm>
      )}
    </>
  );
}
