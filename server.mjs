#!/usr/bin/env node
// MCP basico de TikTok. Automatiza la web de TikTok con Brave y un perfil dedicado.
// stdout pertenece al protocolo MCP: todo log debe ir a stderr.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chromium } from "playwright-core";
import { z } from "zod";

const DEFAULT_BRAVE_PATHS = {
  win32: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  darwin: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  linux: "/usr/bin/brave-browser",
};
const BRAVE_PATH = process.env.BRAVE_PATH ?? DEFAULT_BRAVE_PATHS[process.platform];
const DATA_DIR =
  process.env.TIKTOK_MCP_DIR ??
  join(process.env.LOCALAPPDATA ?? homedir(), "mcp-tiktok");
const PROFILE_DIR = join(DATA_DIR, "brave-profile");
const SHOTS_DIR = join(DATA_DIR, "screenshots");
const IDLE_CLOSE_MS = 5 * 60_000;

const STUDIO_UPLOAD = "https://www.tiktok.com/tiktokstudio/upload";
const STUDIO_CONTENT = "https://www.tiktok.com/tiktokstudio/content";
const VIDEO_URL_RE =
  /^https:\/\/(www\.)?tiktok\.com\/@[\w.-]+\/video\/\d+\/?(\?.*)?$/;
const CAPTCHA_SELECTOR =
  '#captcha-verify-container, #captcha_container, .captcha-verify-container, [class*="captcha_verify"]';

// Valores observados en item_list. 1 es seguro; 2 y 3 se dedujeron de la tabla de Studio.
const VISIBILITY = { 1: "public", 2: "private", 3: "friends" };

// Textos de la interfaz (es/en) para elegir quien puede ver el video.
const PRIVACY_LABELS = {
  public: ["Todo el mundo", "Everyone"],
  friends: ["Amigos", "Friends"],
  private: ["Solo yo", "Only you", "Only me"],
};

class UserActionNeeded extends Error {}

// ---------- Navegador ----------

let context = null;
let idleTimer = null;
let queue = Promise.resolve();

// Una sola operacion a la vez: todas comparten la misma ventana de Brave.
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function getContext() {
  clearTimeout(idleTimer);
  if (context) return context;
  if (!existsSync(BRAVE_PATH)) {
    throw new Error(`No encuentro Brave en ${BRAVE_PATH}. Define BRAVE_PATH.`);
  }
  mkdirSync(PROFILE_DIR, { recursive: true });
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: BRAVE_PATH,
    headless: false,
    // El sandbox de Chromium no arranca con el perfil seccomp por defecto de Docker.
    chromiumSandbox: process.env.TIKTOK_NO_SANDBOX !== "1",
    viewport: null,
    args: ["--start-maximized"],
  });
  context.on("close", () => {
    context = null;
  });
  return context;
}

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    serial(async () => {
      await context?.close();
    }).catch((e) => console.error("Error al cerrar Brave:", e));
  }, IDLE_CLOSE_MS);
  idleTimer.unref();
}

// TikTok Studio muestra tutoriales guiados (react-joyride) cuya capa bloquea los clics.
// Solo actua dentro del tutorial, asi nunca puede pulsar Publicar.
async function dismissTours(page) {
  const overlay = page.locator(".react-joyride__overlay");
  const tooltip = page.locator(".react-joyride__tooltip");
  await page.addLocatorHandler(overlay, async () => {
    for (let i = 0; i < 8 && (await overlay.isVisible().catch(() => false)); i++) {
      const button = tooltip
        .locator('[data-test-id="button-skip"], [data-test-id="button-close"], [data-test-id="button-primary"]')
        .first();
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 3000 }).catch(() => {});
      } else {
        await page.keyboard.press("Escape");
      }
      await page.waitForTimeout(400);
    }
  });
}

async function withPage(fn) {
  return serial(async () => {
    const ctx = await getContext();
    const page = await ctx.newPage();
    try {
      await dismissTours(page);
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
      scheduleIdleClose();
    }
  });
}

async function assertUsable(page) {
  if (/\/login/.test(page.url())) {
    throw new UserActionNeeded(
      "No hay sesion iniciada en el perfil del MCP. Ejecuta tiktok_login.",
    );
  }
  if (await page.locator(CAPTCHA_SELECTOR).first().isVisible().catch(() => false)) {
    throw new UserActionNeeded(
      "TikTok muestra un captcha. Resuelvelo a mano en la ventana de Brave y reintenta.",
    );
  }
}

async function screenshot(page, name) {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const path = join(SHOTS_DIR, `${name}-${Date.now()}.png`);
  await page.screenshot({ path }).catch(() => {});
  return path;
}

// ---------- Metricas ----------

function toVideo(item) {
  return {
    id: item.item_id,
    description: item.desc,
    url: `https://www.tiktok.com/video/${item.item_id}`,
    created_at: new Date(Number(item.create_time) * 1000).toISOString(),
    // item_list entrega la duracion en milisegundos.
    duration_s: Math.round(item.duration / 1000),
    visibility: VISIBILITY[item.visibility] ?? `unknown(${item.visibility})`,
    views: Number(item.play_count),
    likes: Number(item.like_count),
    comments: Number(item.comment_count),
    shares: Number(item.share_count),
    favorites: Number(item.favorite_count),
  };
}

// Escucha la respuesta que la propia pagina de Studio pide; no reproduce sus firmas.
async function collectVideos(page, stopWhen) {
  const videos = new Map();
  let hasMore = true;
  let received = 0;
  page.on("response", async (res) => {
    if (!res.url().includes("/creator/manage/item_list/")) return;
    try {
      const body = await res.json();
      if (body.status_code !== 0) return;
      for (const item of body.item_list ?? []) {
        videos.set(item.item_id, toVideo(item));
      }
      hasMore = Boolean(body.has_more);
      received++;
    } catch (e) {
      console.error("item_list ilegible:", e);
    }
  });

  await page.goto(STUDIO_CONTENT, { waitUntil: "domcontentloaded" });
  const deadline = Date.now() + 20_000;
  while (received === 0 && Date.now() < deadline) {
    await assertUsable(page);
    await page.waitForTimeout(500);
  }
  if (received === 0) {
    throw new Error("TikTok Studio no devolvio la lista de videos en 20 s.");
  }

  let stalled = 0;
  while (hasMore && !stopWhen(videos) && stalled < 6) {
    const before = received;
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("*")) {
        if (
          el.scrollHeight > el.clientHeight + 50 &&
          getComputedStyle(el).overflowY !== "visible"
        ) {
          el.scrollTop = el.scrollHeight;
        }
      }
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(1500);
    stalled = received === before ? stalled + 1 : 0;
  }
  return { videos: [...videos.values()], complete: !hasMore };
}

async function accountStats(username) {
  return withPage(async (page) => {
    await page.goto(`https://www.tiktok.com/@${username}`, {
      waitUntil: "domcontentloaded",
    });
    await assertUsable(page);
    const text = async (key) =>
      (await page.locator(`[data-e2e="${key}"]`).first().textContent({ timeout: 15_000 })).trim();
    return {
      username,
      followers: await text("followers-count"),
      following: await text("following-count"),
      likes: await text("likes-count"),
    };
  });
}

// ---------- Subida ----------

async function selectPrivacy(page, privacy) {
  const labels = PRIVACY_LABELS[privacy];
  const allLabels = Object.values(PRIVACY_LABELS).flat();
  const anyLabel = new RegExp(`^\\s*(${allLabels.join("|")})\\s*$`);
  const wanted = new RegExp(`^\\s*(${labels.join("|")})\\s*$`);

  const dropdown = page
    .locator('button[aria-haspopup], [role="combobox"], .Select__trigger, [class*="Select"] button')
    .filter({ hasText: anyLabel })
    .first();
  await dropdown.waitFor({ timeout: 15_000 });

  if (!wanted.test((await dropdown.textContent()) ?? "")) {
    await dropdown.click();
    await page
      .locator('[role="option"], [role="menuitem"], [role="listbox"] *')
      .filter({ hasText: wanted })
      .first()
      .click({ timeout: 10_000 });
  }

  // Si no se confirma, se aborta: nunca publicar con privacidad distinta a la pedida.
  const selected = ((await dropdown.textContent()) ?? "").trim();
  if (!wanted.test(selected)) {
    throw new Error(
      `No pude confirmar la privacidad "${privacy}" (la pagina muestra "${selected}"). No se publico nada.`,
    );
  }
  return selected;
}

async function uploadVideo({ path, caption, privacy, publish }) {
  return withPage(async (page) => {
    await page.goto(STUDIO_UPLOAD, { waitUntil: "domcontentloaded" });
    const input = page.locator('input[type="file"][accept*="video"]');
    // Sin sesion, Studio redirige a /login despues de cargar.
    await Promise.race([
      input.waitFor({ state: "attached", timeout: 30_000 }),
      page.waitForURL(/\/login/, { timeout: 30_000 }).catch(() => new Promise(() => {})),
    ]);
    await assertUsable(page);
    await input.setInputFiles(path);

    const captionBox = page.locator('.public-DraftEditor-content[contenteditable="true"]').first();
    await captionBox.waitFor({ timeout: 120_000 });
    await assertUsable(page);

    if (caption) {
      await captionBox.click();
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Delete");
      await page.keyboard.type(caption, { delay: 15 });
      // Cierra la sugerencia de hashtags para que no capture el siguiente clic.
      await page.keyboard.press("Escape");
    }

    const selectedPrivacy = await selectPrivacy(page, privacy);

    const postButton = page.locator('[data-e2e="post_video_button"]');
    await postButton.waitFor({ timeout: 30_000 });
    // El boton se habilita al terminar la subida y el procesamiento del archivo.
    await page.waitForFunction(
      (sel) => {
        const b = document.querySelector(sel);
        return b && !b.disabled && b.getAttribute("aria-disabled") !== "true"
          && b.getAttribute("data-disabled") !== "true";
      },
      '[data-e2e="post_video_button"]',
      { timeout: 10 * 60_000 },
    );

    if (!publish) {
      return {
        published: false,
        privacy: selectedPrivacy,
        screenshot: await screenshot(page, "upload-preview"),
        note: "Prueba: formulario completo, sin publicar. Al cerrar la pagina se descarta.",
      };
    }

    await postButton.click();
    const done = await page
      .waitForURL(/\/tiktokstudio\/content/, { timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    if (!done) {
      await assertUsable(page);
      return {
        published: "unconfirmed",
        screenshot: await screenshot(page, "upload-unconfirmed"),
        note: "Se pulso Publicar pero TikTok no redirigio a Publicaciones. Revisa la captura antes de reintentar para no duplicar.",
      };
    }
    return { published: true, privacy: selectedPrivacy };
  });
}

// ---------- Comentarios ----------

async function postComment({ video_url, text }) {
  return withPage(async (page) => {
    await page.goto(video_url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await assertUsable(page);

    const box = page.locator('[data-e2e="comment-text"] [contenteditable="true"]');
    if (!(await box.isVisible().catch(() => false))) {
      await page.locator('[data-e2e="comments"][role="tab"], [data-e2e="comment-icon"]').first().click({ timeout: 20_000 });
    }
    await box.waitFor({ timeout: 20_000 });
    await box.click();
    await page.keyboard.type(text, { delay: 25 });
    await page.keyboard.press("Escape");

    const response = page
      .waitForResponse((r) => r.url().includes("/comment/publish"), { timeout: 20_000 })
      .catch(() => null);
    await page.locator('[data-e2e="comment-post"]').click({ timeout: 10_000 });
    const res = await response;
    if (!res) {
      await assertUsable(page);
      return {
        posted: "unconfirmed",
        screenshot: await screenshot(page, "comment-unconfirmed"),
        note: "No vi la respuesta de TikTok. Revisa la captura antes de reintentar para no duplicar.",
      };
    }
    const body = await res.json().catch(() => ({}));
    if (body.status_code !== 0) {
      throw new Error(`TikTok rechazo el comentario: ${body.status_msg ?? "sin detalle"} (${body.status_code})`);
    }
    return { posted: true, comment_id: body.comment?.cid, video_url };
  });
}

// ---------- Login ----------

async function login(timeoutMinutes) {
  return serial(async () => {
    const ctx = await getContext();
    const page = await ctx.newPage();
    const logged = () =>
      page.url().includes("/tiktokstudio/") &&
      !/\/login/.test(page.url());
    try {
      await page.goto(STUDIO_CONTENT, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
      const deadline = Date.now() + timeoutMinutes * 60_000;
      while (!logged() && Date.now() < deadline) {
        await page.waitForTimeout(1000);
      }
      return logged();
    } catch (e) {
      if (page.isClosed()) {
        throw new UserActionNeeded(
          "La ventana de Brave se cerro antes de iniciar sesion. Ejecuta tiktok_login otra vez y dejala abierta.",
        );
      }
      throw e;
    } finally {
      await page.close().catch(() => {});
      scheduleIdleClose();
    }
  });
}

// ---------- MCP ----------

const server = new McpServer({ name: "tiktok", version: "0.1.0" });

function tool(name, description, schema, handler) {
  server.registerTool(name, { description, inputSchema: schema }, async (args) => {
    try {
      const result = await handler(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      console.error(`${name}:`, e);
      return { isError: true, content: [{ type: "text", text: e.message }] };
    }
  });
}

tool(
  "tiktok_login",
  "Abre Brave con el perfil del MCP para que la persona inicie sesion a mano. Solo hace falta una vez. En Docker la ventana se ve en http://localhost:6080/vnc.html.",
  { timeout_minutes: z.number().min(1).max(15).default(5) },
  async ({ timeout_minutes }) => {
    const ok = await login(timeout_minutes);
    if (!ok) throw new UserActionNeeded("No se detecto el inicio de sesion a tiempo.");
    return { logged_in: true };
  },
);

tool(
  "tiktok_list_videos",
  "Lista los videos propios con vistas, likes, comentarios, compartidos y guardados, del mas reciente al mas antiguo.",
  { limit: z.number().int().min(1).max(500).default(20) },
  async ({ limit }) => {
    const { videos, complete } = await withPage((page) =>
      collectVideos(page, (seen) => seen.size >= limit),
    );
    return { count: Math.min(videos.length, limit), complete, videos: videos.slice(0, limit) };
  },
);

tool(
  "tiktok_get_video",
  "Devuelve las metricas de un video propio por su id.",
  { video_id: z.string().regex(/^\d+$/) },
  async ({ video_id }) => {
    const { videos } = await withPage((page) =>
      collectVideos(page, (seen) => seen.has(video_id)),
    );
    const video = videos.find((v) => v.id === video_id);
    if (!video) throw new Error(`No encontre el video ${video_id} en esta cuenta.`);
    return video;
  },
);

tool(
  "tiktok_account_stats",
  "Devuelve seguidores, seguidos y likes totales de una cuenta.",
  { username: z.string().regex(/^[\w.-]+$/).optional() },
  ({ username = process.env.TIKTOK_USERNAME }) => {
    if (!username) throw new Error("Indica username o define TIKTOK_USERNAME.");
    return accountStats(username);
  },
);

tool(
  "tiktok_upload_video",
  "Sube un video desde un archivo local. Por defecto NO publica (publish=false): solo llena el formulario y devuelve una captura. Con publish=true publica de verdad.",
  {
    path: z.string().describe("Ruta absoluta del video (.mp4, .mov o .webm)"),
    caption: z.string().max(4000).default(""),
    privacy: z.enum(["private", "friends", "public"]).default("private"),
    publish: z.boolean().default(false),
  },
  async (args) => {
    if (!isAbsolute(args.path) || !existsSync(args.path) || !statSync(args.path).isFile()) {
      throw new Error(`Archivo no encontrado (usa ruta absoluta): ${args.path}`);
    }
    if (![".mp4", ".mov", ".webm"].includes(extname(args.path).toLowerCase())) {
      throw new Error("Formato no soportado: usa .mp4, .mov o .webm.");
    }
    return uploadVideo(args);
  },
);

tool(
  "tiktok_post_comment",
  "Publica un comentario real con la cuenta en un video de TikTok.",
  {
    video_url: z.string().regex(VIDEO_URL_RE, "Debe ser https://www.tiktok.com/@usuario/video/ID"),
    text: z.string().trim().min(1).max(150),
  },
  postComment,
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await context?.close().catch(() => {});
    process.exit(0);
  });
}

await server.connect(new StdioServerTransport());
console.error("mcp-tiktok listo");
