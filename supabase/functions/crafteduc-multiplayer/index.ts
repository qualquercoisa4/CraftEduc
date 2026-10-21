import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const allowedApiKeys = (() => {
  try { return Object.values(JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}") as Record<string, string>); }
  catch { return []; }
})();
const db = supabaseUrl && serviceKey
  ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

const SESSION_TTL_MS = 25_000;
const roomPattern = /^[a-z0-9_-]{4,20}$/;
const playerKeyPattern = /^[a-zA-Z0-9_-]{16,80}$/;
const hostKeyPattern = /^[a-zA-Z0-9_-]{24,100}$/;
const clampText = (v: unknown, max: number, fallback = "") =>
  String(v ?? fallback).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) || fallback;

const DEFAULT_RULES = { playersCanOnlyDestroyOwnBlocks: true, playersCanFly: false };
const DEFAULT_SHARED_STATE = { wires: [], contraptions: [], movingBlocks: [], worldTime: 0 };

function validRoom(v: unknown): v is string { return typeof v === "string" && roomPattern.test(v); }
function validPlayerKey(v: unknown): v is string { return typeof v === "string" && playerKeyPattern.test(v); }
function validHostKey(v: unknown): v is string { return typeof v === "string" && hostKeyPattern.test(v); }
function finite(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function safeRules(value: unknown) {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    playersCanOnlyDestroyOwnBlocks: typeof v.playersCanOnlyDestroyOwnBlocks === "boolean" ? v.playersCanOnlyDestroyOwnBlocks : DEFAULT_RULES.playersCanOnlyDestroyOwnBlocks,
    playersCanFly: typeof v.playersCanFly === "boolean" ? v.playersCanFly : DEFAULT_RULES.playersCanFly,
  };
}
function safeBlockState(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const out: Record<string, number | boolean> = {};
  if (Number.isInteger(v.facing) && Number(v.facing) >= 0 && Number(v.facing) <= 5) out.facing = Number(v.facing);
  if (Number.isInteger(v.batteries) && Number(v.batteries) >= 0 && Number(v.batteries) <= 3) out.batteries = Number(v.batteries);
  if (Number.isInteger(v.glue) && Number(v.glue) >= 0 && Number(v.glue) <= 63) out.glue = Number(v.glue);
  if (typeof v.mountedWheel === "boolean") out.mountedWheel = v.mountedWheel;
  return out;
}
function safeSkin(value: unknown) {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const color = (x: unknown, fallback: string) => typeof x === "string" && /^#[0-9a-fA-F]{6}$/.test(x) ? x : fallback;
  const accessory = ["none", "glasses", "goggles", "antenna", "cap", "headphones"].includes(String(v.accessory)) ? String(v.accessory) : "none";
  return {
    skin: color(v.skin, "#d9a079"),
    hair: color(v.hair, "#4a3022"),
    shirt: color(v.shirt, "#2878cf"),
    pants: color(v.pants, "#334155"),
    shoes: color(v.shoes, "#2b2b2b"),
    accessory,
    accessoryColor: color(v.accessoryColor, "#f4c542"),
  };
}
function safePlayerData(value: unknown, allowFly: boolean) {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
  return {
    x: clamp(finite(v.x), -1_000_000, 1_000_000),
    y: clamp(finite(v.y, 8), -20, 100_000),
    z: clamp(finite(v.z), -1_000_000, 1_000_000),
    yaw: clamp(finite(v.yaw), -Math.PI * 100, Math.PI * 100),
    pitch: clamp(finite(v.pitch), -Math.PI / 2, Math.PI / 2),
    flying: allowFly && v.flying === true,
    sneaking: v.sneaking === true,
    onGround: v.onGround === true,
    velocityX: clamp(finite(v.velocityX), -80, 80),
    velocityY: clamp(finite(v.velocityY), -80, 80),
    velocityZ: clamp(finite(v.velocityZ), -80, 80),
  };
}
function sessionIsFresh(world: Record<string, unknown>) {
  const seen = typeof world.host_last_seen === "string" ? Date.parse(world.host_last_seen) : Number.NaN;
  return world.session_status === "open" && Number.isFinite(seen) && Date.now() - seen <= SESSION_TTL_MS;
}
function publicWorld(world: Record<string, unknown>) {
  return {
    roomId: world.room_id,
    seed: world.seed,
    sessionStatus: world.session_status,
    hostLastSeen: world.host_last_seen,
    rules: safeRules(world.rules),
    sharedState: world.shared_state && typeof world.shared_state === "object" ? world.shared_state : DEFAULT_SHARED_STATE,
    createdAt: world.created_at,
    updatedAt: world.updated_at,
  };
}
async function getWorld(roomId: string) {
  const { data, error } = await db!.from("crafteduc_multiplayer_worlds").select("*").eq("room_id", roomId).maybeSingle();
  if (error) throw error;
  return data as Record<string, unknown> | null;
}
async function requireActiveWorld(roomId: string) {
  const world = await getWorld(roomId);
  if (!world) return { world: null, status: 404, error: "Esse servidor não existe. Confira o código e tente novamente." };
  if (!sessionIsFresh(world)) {
    if (world.session_status === "open") await db!.from("crafteduc_multiplayer_worlds")
      .update({ session_status: "closed", host_last_seen: null, updated_at: new Date().toISOString() })
      .eq("room_id", roomId).eq("host_key", String(world.host_key ?? "")).eq("session_status", "open");
    return { world: null, status: 410, error: "O servidor está fechado: o anfitrião saiu ou perdeu a conexão." };
  }
  return { world, status: 200, error: "" };
}
async function loadBlocks(roomId: string) {
  const out: unknown[] = [];
  const pageSize = 1000;
  for (let offset = 0; offset < 20_000; offset += pageSize) {
    const { data, error } = await db!.from("crafteduc_multiplayer_blocks")
      .select("x,y,z,block_id,block_state,owner_key,updated_at")
      .eq("room_id", roomId).order("updated_at", { ascending: true }).range(offset, offset + pageSize - 1);
    if (error) throw error;
    for (const row of data ?? []) out.push({
      x: row.x, y: row.y, z: row.z, block: row.block_id, state: row.block_state,
      ownerKey: row.owner_key, updatedAt: new Date(row.updated_at).getTime(),
    });
    if (!data || data.length < pageSize) break;
  }
  return out;
}
async function loadWires(roomId: string) {
  const { data, error } = await db!.from("crafteduc_multiplayer_wires").select("wire_id,wire_data,owner_key")
    .eq("room_id", roomId).order("updated_at", { ascending: true }).limit(3000);
  if (error) throw error;
  return (data ?? []).map((w) => ({ id: w.wire_id, ...(w.wire_data as Record<string, unknown>), ownerKey: w.owner_key }));
}
async function loadPlayers(roomId: string) {
  const cutoff = new Date(Date.now() - 20_000).toISOString();
  const { data, error } = await db!.from("crafteduc_multiplayer_players")
    .select("player_key,player_name,player_data,skin,updated_at")
    .eq("room_id", roomId).gte("updated_at", cutoff).order("updated_at", { ascending: true }).limit(64);
  if (error) throw error;
  return (data ?? []).map((p) => ({
    id: p.player_key, name: p.player_name, data: p.player_data, skin: safeSkin(p.skin),
    updatedAt: new Date(p.updated_at).getTime(),
  }));
}
async function loadChat(roomId: string) {
  const { data, error } = await db!.from("crafteduc_multiplayer_chat")
    .select("id,player_key,player_name,message,created_at")
    .eq("room_id", roomId).order("id", { ascending: false }).limit(50);
  if (error) throw error;
  return (data ?? []).reverse().map((row) => ({
    id: String(row.id), playerId: row.player_key, playerName: row.player_name,
    message: row.message, createdAt: row.created_at,
  }));
}
async function latestEventId(roomId: string) {
  const { data, error } = await db!.from("crafteduc_multiplayer_events").select("id")
    .eq("room_id", roomId).order("id", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return Number(data?.id ?? 0);
}
async function roomPayload(roomId: string, playerKey: unknown, world: Record<string, unknown>) {
  // Capture the event cursor BEFORE loading the snapshot. If the cursor and
  // blocks are loaded concurrently, a block edit can land between those
  // queries: the snapshot misses it while the cursor skips its event forever.
  // A cursor-first snapshot may replay an edit already included in the snapshot,
  // which is safe because block and wire application are idempotent.
  const cursor = await latestEventId(roomId);
  const [blocks, wires, players, chat] = await Promise.all([
    loadBlocks(roomId), loadWires(roomId), loadPlayers(roomId), loadChat(roomId),
  ]);
  let playerSave = null;
  if (validPlayerKey(playerKey)) {
    const { data, error } = await db!.from("crafteduc_multiplayer_players").select("player_name,player_data,skin")
      .eq("room_id", roomId).eq("player_key", playerKey).maybeSingle();
    if (error) throw error;
    if (data) playerSave = { name: data.player_name, data: data.player_data, skin: safeSkin(data.skin) };
  }
  return { world: publicWorld(world), blocks, wires, players, cursor, chat, playerSave };
}
async function writeEvent(roomId: string, eventType: string, payload: unknown) {
  const { data, error } = await db!.from("crafteduc_multiplayer_events")
    .insert({ room_id: roomId, event_type: eventType, payload }).select("id").single();
  if (error) throw error;
  return Number(data.id);
}
async function postChat(roomId: string, playerKey: string, name: string, messageValue: unknown) {
  const message = clampText(messageValue, 256);
  if (!message) return json({ error: "Digite uma mensagem antes de enviar." }, 400);
  const threshold = new Date(Date.now() - 650).toISOString();
  const { data: recent, error: rateError } = await db!.from("crafteduc_multiplayer_chat")
    .select("id").eq("room_id", roomId).eq("player_key", playerKey).gte("created_at", threshold).limit(1);
  if (rateError) throw rateError;
  if (recent?.length) return json({ error: "Aguarde um instante antes de enviar outra mensagem." }, 429);
  const { data, error } = await db!.from("crafteduc_multiplayer_chat")
    .insert({ room_id: roomId, player_key: playerKey, player_name: name, message })
    .select("id,created_at").single();
  if (error) throw error;
  return json({ ok: true, chat: { id: String(data.id), playerId: playerKey, playerName: name, message, createdAt: data.created_at } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);
  if (!db) return json({ error: "O armazenamento multiplayer não está configurado." }, 503);
  const requestKey = req.headers.get("apikey") ?? "";
  const legacyPublicKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!requestKey || !(requestKey === legacyPublicKey || allowedApiKeys.includes(requestKey))) {
    return json({ error: "Chave pública de cliente inválida." }, 401);
  }
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > 2_000_000) return json({ error: "Requisição muito grande." }, 413);
  try {
    const input = JSON.parse(raw) as Record<string, unknown>;
    const action = String(input.action ?? "");
    const roomId = typeof input.roomId === "string" ? input.roomId.toLowerCase().trim() : "";
    if (!validRoom(roomId)) return json({ error: "Código do servidor inválido." }, 400);

    if (action === "create_room") {
      const hostKey = input.hostKey;
      const playerKey = input.playerKey;
      if (!validHostKey(hostKey) || !validPlayerKey(playerKey)) return json({ error: "Chaves de anfitrião ou jogador inválidas." }, 400);
      const requestedSeed = Number.isInteger(input.seed) && Number(input.seed) >= 0 && Number(input.seed) <= 0x7fffffff ? Number(input.seed) : 24681357;
      const existing = await getWorld(roomId);
      const now = new Date().toISOString();
      let world: Record<string, unknown>;
      if (!existing) {
        const { data, error } = await db!.from("crafteduc_multiplayer_worlds").insert({
          room_id: roomId, seed: requestedSeed, host_key: hostKey, session_status: "open", host_last_seen: now,
          rules: DEFAULT_RULES, shared_state: DEFAULT_SHARED_STATE, updated_at: now,
        }).select("*").single();
        if (error || !data) {
          if (error?.code === "23505") return json({ error: "Esse código já está em uso. Escolha outro ou entre no servidor." }, 409);
          throw error ?? new Error("Não foi possível criar o servidor.");
        }
        world = data as Record<string, unknown>;
      } else {
        if (sessionIsFresh(existing)) return json({ error: "Já existe um servidor ativo com esse código." }, 409);
        // A new host gets a clean room. Never mix edits or player state from a stale session.
        for (const table of [
          "crafteduc_multiplayer_blocks", "crafteduc_multiplayer_wires", "crafteduc_multiplayer_events",
          "crafteduc_multiplayer_players", "crafteduc_multiplayer_chat",
        ]) {
          const { error: clearError } = await db!.from(table).delete().eq("room_id", roomId);
          if (clearError) throw clearError;
        }
        const { data, error } = await db!.from("crafteduc_multiplayer_worlds").update({
          host_key: hostKey, session_status: "open", host_last_seen: now, seed: requestedSeed,
          rules: DEFAULT_RULES, shared_state: DEFAULT_SHARED_STATE, updated_at: now,
        }).eq("room_id", roomId).select("*").single();
        if (error || !data) throw error ?? new Error("Não foi possível reabrir esse servidor.");
        world = data as Record<string, unknown>;
      }
      await db!.from("crafteduc_multiplayer_players").upsert({
        room_id: roomId, player_key: playerKey, player_name: clampText(input.playerName, 20, "Anfitrião"),
        player_data: { x: 0.5, y: 4, z: 0.5, yaw: 0, pitch: -0.15, flying: false }, skin: safeSkin(input.skin), updated_at: now,
      });
      const payload = await roomPayload(roomId, playerKey, world);
      return json({ ...payload, isHost: true });
    }

    if (action === "room_status") {
      const world = await getWorld(roomId);
      return json({ online: Boolean(world && sessionIsFresh(world)), rules: world ? safeRules(world.rules) : DEFAULT_RULES });
    }

    const required = await requireActiveWorld(roomId);
    if (!required.world) return json({ error: required.error }, required.status);
    const world = required.world;
    const playerKey = input.playerKey;
    if (action === "join") {
      if (!validPlayerKey(playerKey)) return json({ error: "Identificador de jogador inválido." }, 400);
      const now = new Date().toISOString();
      let spawnHash = 0;
      for (const ch of playerKey) spawnHash = (spawnHash * 31 + ch.charCodeAt(0)) >>> 0;
      const angle = (spawnHash % 360) * Math.PI / 180;
      const radius = 3 + ((spawnHash >>> 8) % 30) / 10;
      const spawnX = Math.round((0.5 + Math.cos(angle) * radius) * 2) / 2;
      const spawnZ = Math.round((0.5 + Math.sin(angle) * radius) * 2) / 2;
      await db!.from("crafteduc_multiplayer_players").upsert({
        room_id: roomId, player_key: playerKey, player_name: clampText(input.playerName, 20, "Jogador"),
        player_data: { x: spawnX, y: 4, z: spawnZ, yaw: 0, pitch: -0.15, flying: false },
        skin: safeSkin(input.skin), updated_at: now,
      });
      return json({ ...(await roomPayload(roomId, playerKey, world)), isHost: false });
    }

    const hostKey = input.hostKey;
    const isHost = validHostKey(hostKey) && hostKey === world.host_key;
    const now = new Date().toISOString();

    if (action === "host_heartbeat") {
      if (!isHost) return json({ error: "Somente o anfitrião pode manter esta sessão aberta." }, 403);
      const { data, error } = await db!.from("crafteduc_multiplayer_worlds").update({ host_last_seen: now, updated_at: now })
        .eq("room_id", roomId).eq("host_key", hostKey).eq("session_status", "open").select("room_id").maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "Esta sessão não pertence mais a este anfitrião." }, 409);
      return json({ ok: true });
    }

    if (action === "close_room") {
      if (!isHost) return json({ error: "Somente o anfitrião pode fechar este servidor." }, 403);
      const { data, error } = await db!.from("crafteduc_multiplayer_worlds").update({ session_status: "closed", host_last_seen: null, updated_at: now })
        .eq("room_id", roomId).eq("host_key", hostKey).eq("session_status", "open").select("room_id").maybeSingle();
      if (error) throw error;
      await db!.from("crafteduc_multiplayer_players").delete().eq("room_id", roomId).eq("player_key", playerKey);
      if (!data) return json({ error: "O servidor já foi fechado ou a chave não confere." }, 409);
      return json({ ok: true, online: false });
    }

    if (action === "leave") {
      if (!validPlayerKey(playerKey)) return json({ error: "Identificador de jogador inválido." }, 400);
      if (isHost) {
        await db!.from("crafteduc_multiplayer_worlds").update({ session_status: "closed", host_last_seen: null, updated_at: now })
          .eq("room_id", roomId).eq("host_key", hostKey).eq("session_status", "open");
      }
      const { error } = await db!.from("crafteduc_multiplayer_players").delete().eq("room_id", roomId).eq("player_key", playerKey);
      if (error) throw error;
      return json({ ok: true, online: false });
    }

    if (action === "poll") {
      const cursor = Math.max(0, Math.floor(finite(input.cursor)));
      const { data: events, error } = await db!.from("crafteduc_multiplayer_events")
        .select("id,event_type,payload,created_at").eq("room_id", roomId).gt("id", cursor).order("id", { ascending: true }).limit(250);
      if (error) throw error;
      const [players, currentWorld, chat] = await Promise.all([loadPlayers(roomId), getWorld(roomId), loadChat(roomId)]);
      if (!currentWorld || !sessionIsFresh(currentWorld)) return json({ error: "O anfitrião desconectou do servidor." }, 410);
      return json({
        world: publicWorld(currentWorld),
        events: (events ?? []).map((e) => ({ id: Number(e.id), type: e.event_type, payload: e.payload, createdAt: e.created_at })),
        players, chat,
        cursor: events?.length ? Number(events[events.length - 1].id) : cursor,
      });
    }

    if (action === "save_player") {
      if (!validPlayerKey(playerKey)) return json({ error: "Identificador de jogador inválido." }, 400);
      const rules = safeRules(world.rules);
      const name = clampText(input.playerName, 20, "Jogador");
      const data = safePlayerData(input.playerData, isHost || rules.playersCanFly);
      const skin = safeSkin(input.skin);
      const { error } = await db!.from("crafteduc_multiplayer_players").upsert({
        room_id: roomId, player_key: playerKey, player_name: name, player_data: data, skin, updated_at: now,
      });
      if (error) throw error;
      return json({ ok: true, player: { id: playerKey, name, data, skin, updatedAt: Date.now() } });
    }

    if (action === "request_moving_action") {
      if (!validPlayerKey(playerKey)) return json({ error: "Identificador de jogador inválido." }, 400);
      const rawIntent = input.intent;
      if (!rawIntent || typeof rawIntent !== "object" || Array.isArray(rawIntent)) return json({ error: "Ação de máquina inválida." }, 400);
      const intent = rawIntent as Record<string, unknown>;
      const movingKey = typeof intent.movingKey === "string" ? intent.movingKey : "";
      if (!/^-?\\d+,-?\\d+,-?\\d+$/.test(movingKey)
        || (intent.action !== "break" && intent.action !== "use")
        || !["rotor", "chassis", "falling"].includes(String(intent.movingKind))
        || !Number.isInteger(intent.face) || Number(intent.face) < 0 || Number(intent.face) > 5
        || (intent.item !== null && !(typeof intent.item === "string" && [
          "robotics", "iron", "wood", "component", "aluminum", "gear", "led", "motor",
          "wire", "glue", "battery_box", "battery", "wheel",
        ].includes(intent.item)))) {
        return json({ error: "A ação de máquina contém dados inválidos." }, 400);
      }
      if (intent.action === "break" && !isHost && safeRules(world.rules).playersCanOnlyDestroyOwnBlocks) {
        const [x, y, z] = movingKey.split(",").map(Number);
        const { data: block, error: blockError } = await db!.from("crafteduc_multiplayer_blocks")
          .select("block_id,owner_key").eq("room_id", roomId).eq("x", x).eq("y", y).eq("z", z).maybeSingle();
        if (blockError) throw blockError;
        if (!block || Number(block.block_id) === 0 || block.owner_key !== playerKey) {
          return json({ error: "Este servidor permite quebrar apenas os blocos que você colocou." }, 403);
        }
      }
      const playerName = clampText(input.playerName, 20, "Jogador");
      const payload = {
        playerKey, playerName, action: intent.action, movingKey, movingKind: intent.movingKind,
        face: Number(intent.face), item: intent.item, sneaking: intent.sneaking === true,
      };
      const eventId = await writeEvent(roomId, "action_intent", payload);
      return json({ ok: true, eventId });
    }

    if (action === "sync_initial_world") {
      if (!isHost) return json({ error: "Somente o anfitrião pode inicializar o mundo compartilhado." }, 403);
      if (!validPlayerKey(playerKey)) return json({ error: "Identificador de jogador inválido." }, 400);
      const rawBlocks = Array.isArray(input.blocks) ? input.blocks : null;
      const rawWires = Array.isArray(input.wires) ? input.wires : null;
      if (!rawBlocks || !rawWires || rawBlocks.length > 20000 || rawWires.length > 3000) {
        return json({ error: "O estado inicial excede o limite permitido." }, 413);
      }
      const blocks: Record<string, unknown>[] = [];
      for (const raw of rawBlocks) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return json({ error: "Bloco inicial inválido." }, 400);
        const b = raw as Record<string, unknown>;
        const x = Number(b.x), y = Number(b.y), z = Number(b.z), block = Number(b.block);
        if (![x, y, z, block].every(Number.isInteger) || Math.abs(x) > 1000000 || Math.abs(z) > 1000000 || y < 4 || y >= 64 || block < 1 || block > 255) {
          return json({ error: "Coordenadas ou tipo de bloco inicial inválidos." }, 400);
        }
        blocks.push({
          room_id: roomId, x, y, z, block_id: block,
          block_state: safeBlockState(b.state), owner_key: playerKey, updated_at: now,
        });
      }
      const wires: Record<string, unknown>[] = [];
      for (const raw of rawWires) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return json({ error: "Fio inicial inválido." }, 400);
        const w = raw as Record<string, unknown>;
        const id = clampText(w.id, 100);
        const validKey = (v: unknown) => typeof v === "string" && /^-?\d+,-?\d+,-?\d+$/.test(v);
        const validPoint = (v: unknown) => !!v && typeof v === "object" && ["x", "y", "z"].every(k => Number.isFinite(Number((v as Record<string, unknown>)[k])));
        if (id.length < 8 || !validKey(w.a) || !validKey(w.b) || typeof w.ta !== "string" || typeof w.tb !== "string" || !validPoint(w.pa) || !validPoint(w.pb)) {
          return json({ error: "Dados do fio inicial inválidos." }, 400);
        }
        wires.push({
          room_id: roomId, wire_id: id,
          wire_data: {
            a: w.a, b: w.b, ta: clampText(w.ta, 30), tb: clampText(w.tb, 30),
            pa: { x: finite((w.pa as Record<string, unknown>).x), y: finite((w.pa as Record<string, unknown>).y), z: finite((w.pa as Record<string, unknown>).z) },
            pb: { x: finite((w.pb as Record<string, unknown>).x), y: finite((w.pb as Record<string, unknown>).y), z: finite((w.pb as Record<string, unknown>).z) },
          },
          owner_key: playerKey, updated_at: now,
        });
      }
      for (let i = 0; i < blocks.length; i += 200) {
        const { error } = await db!.from("crafteduc_multiplayer_blocks").upsert(blocks.slice(i, i + 200));
        if (error) throw error;
      }
      for (let i = 0; i < wires.length; i += 200) {
        const { error } = await db!.from("crafteduc_multiplayer_wires").upsert(wires.slice(i, i + 200));
        if (error) throw error;
      }
      return json({ ok: true, blocks: blocks.length, wires: wires.length, initializedAt: now });
    }

    if (action === "save_block") {
      if (!validPlayerKey(playerKey)) return json({ error: "Identificador de jogador inválido." }, 400);
      const x = Number(input.x), y = Number(input.y), z = Number(input.z), block = Number(input.block);
      if (![x, y, z, block].every(Number.isInteger) || Math.abs(x) > 1_000_000 || Math.abs(z) > 1_000_000 || y < 0 || y >= 64 || block < 0 || block > 255) {
        return json({ error: "Coordenadas ou identificador de bloco inválidos." }, 400);
      }
      if (block !== 0 && !isHost) {
        // Placement is allowed, but never let untrusted clients claim someone else's placed block.
      }
      const { data: current, error: findError } = await db!.from("crafteduc_multiplayer_blocks")
        .select("block_id,owner_key").eq("room_id", roomId).eq("x", x).eq("y", y).eq("z", z).maybeSingle();
      if (findError) throw findError;
      if (block === 0 && !isHost && safeRules(world.rules).playersCanOnlyDestroyOwnBlocks) {
        if (!current || Number(current.block_id) === 0 || current.owner_key !== playerKey) {
          return json({ error: "Este servidor permite quebrar apenas os blocos que você colocou." }, 403);
        }
      }
      const state = block === 0 ? null : safeBlockState(input.state);
      let ownerKey: string | null = null;
      if (block !== 0) {
        if (isHost && Object.prototype.hasOwnProperty.call(input, "ownerKey")) {
          const requestedOwner = input.ownerKey;
          ownerKey = requestedOwner === null ? null : validPlayerKey(requestedOwner) ? requestedOwner : playerKey;
        } else ownerKey = playerKey;
      }
      const { error } = await db!.from("crafteduc_multiplayer_blocks").upsert({
        room_id: roomId, x, y, z, block_id: block, block_state: state, owner_key: ownerKey, updated_at: now,
      });
      if (error) throw error;
      const payload = { x, y, z, block, state, ownerKey, playerKey, updatedAt: Date.now() };
      const eventId = await writeEvent(roomId, "block", payload);
      return json({ ok: true, eventId, block: payload });
    }

    if (action === "save_wire") {
      if (!validPlayerKey(playerKey)) return json({ error: "Identificador de jogador inválido." }, 400);
      const wireId = clampText(input.wireId, 100);
      const v = input.wire && typeof input.wire === "object" && !Array.isArray(input.wire) ? input.wire as Record<string, unknown> : {};
      const validKey = (x: unknown) => typeof x === "string" && /^-?\d+,-?\d+,-?\d+$/.test(x);
      const validPoint = (p: unknown) => !!p && typeof p === "object" && ["x","y","z"].every(k => Number.isFinite(Number((p as Record<string,unknown>)[k])));
      if (wireId.length < 8 || !validKey(v.a) || !validKey(v.b) || typeof v.ta !== "string" || typeof v.tb !== "string" || !validPoint(v.pa) || !validPoint(v.pb)) {
        return json({ error: "Fio ou terminais inválidos." }, 400);
      }
      const wire = {
        a: v.a, b: v.b, ta: clampText(v.ta, 30), tb: clampText(v.tb, 30),
        pa: { x: finite((v.pa as Record<string,unknown>).x), y: finite((v.pa as Record<string,unknown>).y), z: finite((v.pa as Record<string,unknown>).z) },
        pb: { x: finite((v.pb as Record<string,unknown>).x), y: finite((v.pb as Record<string,unknown>).y), z: finite((v.pb as Record<string,unknown>).z) },
      };
      const { error } = await db!.from("crafteduc_multiplayer_wires").upsert({ room_id: roomId, wire_id: wireId, wire_data: wire, owner_key: playerKey, updated_at: now });
      if (error) throw error;
      const eventId = await writeEvent(roomId, "wire_upsert", { id: wireId, ...wire, ownerKey: playerKey });
      return json({ ok: true, eventId });
    }

    if (action === "remove_wires_at") {
      if (!validPlayerKey(playerKey)) return json({ error: "Identificador de jogador inválido." }, 400);
      const key = clampText(input.key, 48);
      const { data: wires, error: findError } = await db!.from("crafteduc_multiplayer_wires")
        .select("wire_id,wire_data,owner_key").eq("room_id", roomId);
      if (findError) throw findError;
      const matches = (wires ?? []).filter(w => {
        const v = w.wire_data as Record<string, unknown>;
        return v.a === key || v.b === key;
      });
      for (const w of matches) {
        const { error } = await db!.from("crafteduc_multiplayer_wires").delete().eq("room_id", roomId).eq("wire_id", w.wire_id);
        if (error) throw error;
        await writeEvent(roomId, "wire_remove", { id: w.wire_id });
      }
      return json({ ok: true, removed: matches.length });
    }

    if (action === "save_simulation") {
      if (!isHost) return json({ error: "Só o anfitrião pode publicar o estado físico das máquinas." }, 403);
      if (!input.sharedState || typeof input.sharedState !== "object" || Array.isArray(input.sharedState)) return json({ error: "Snapshot das máquinas inválido." }, 400);
      const sharedState = input.sharedState as Record<string, unknown>;
      const serialized = JSON.stringify(sharedState);
      if (serialized.length > 500_000) return json({ error: "Snapshot das máquinas excede 500 KB." }, 413);
      const { error } = await db!.from("crafteduc_multiplayer_worlds").update({ shared_state: sharedState, host_last_seen: now, updated_at: now })
        .eq("room_id", roomId).eq("host_key", hostKey).eq("session_status", "open");
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "update_rules") {
      if (!isHost) return json({ error: "Só o anfitrião pode alterar as regras." }, 403);
      const rules = safeRules(input.rules);
      const { error } = await db!.from("crafteduc_multiplayer_worlds").update({ rules, updated_at: now })
        .eq("room_id", roomId).eq("host_key", hostKey).eq("session_status", "open");
      if (error) throw error;
      const eventId = await writeEvent(roomId, "rules", rules);
      return json({ ok: true, rules, eventId });
    }

    if (action === "post_chat") {
      if (!validPlayerKey(playerKey)) return json({ error: "Identificador de jogador inválido." }, 400);
      return await postChat(roomId, playerKey, clampText(input.playerName, 20, "Jogador"), input.message);
    }

    return json({ error: "Ação multiplayer desconhecida." }, 400);
  } catch (error) {
    console.error("crafteduc-multiplayer request failed", error);
    const status = typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status) || 500 : 500;
    return json({ error: error instanceof Error ? error.message : "Falha interna no servidor." }, status);
  }
});
