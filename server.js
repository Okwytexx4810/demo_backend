import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const dataFile = path.join(dataDir, "notes.json");
const distDir = path.resolve(__dirname, "..", "frontend", "dist");
const port = Number(process.env.PORT) || 4000;
const corsOrigin = process.env.CORS_ORIGIN || "*";

const corsHeaders = {
  "Access-Control-Allow-Origin": corsOrigin,
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  ...(corsOrigin === "*" ? {} : { Vary: "Origin" }),
};

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

let writeQueue = Promise.resolve();

function sendJson(res, status, payload) {
  res.writeHead(status, {
    ...corsHeaders,
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1000000) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

async function readNotes() {
  try {
    const raw = await fs.readFile(dataFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((note) => note && typeof note.text === "string")
      .map((note) => ({
        id: String(note.id ?? randomUUID()),
        text: note.text,
        updatedAt: Number(note.updatedAt) || Date.now(),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

async function writeNotes(notes) {
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(dataDir, { recursive: true });
    const tempFile = `${dataFile}.${process.pid}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(notes, null, 2), "utf8");
    await fs.rename(tempFile, dataFile);
  });

  return writeQueue;
}

function validText(body) {
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text || text.length > 5000) return null;
  return text;
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/notes" && req.method === "GET") {
    return sendJson(res, 200, await readNotes());
  }

  if (pathname === "/api/notes" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: "Invalid request body" });
    }

    const text = validText(body);
    if (!text) return sendJson(res, 400, { error: "Text is required" });

    const note = { id: randomUUID(), text, updatedAt: Date.now() };
    const notes = await readNotes();
    notes.unshift(note);
    await writeNotes(notes);
    return sendJson(res, 201, note);
  }

  const match = pathname.match(/^\/api\/notes\/([^/]+)$/);
  if (match) {
    let id;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return sendJson(res, 400, { error: "Invalid note id" });
    }

    if (req.method === "PUT") {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return sendJson(res, 400, { error: "Invalid request body" });
      }

      const text = validText(body);
      if (!text) return sendJson(res, 400, { error: "Text is required" });

      const notes = await readNotes();
      const index = notes.findIndex((note) => note.id === id);
      if (index === -1) return sendJson(res, 404, { error: "Note not found" });

      notes[index] = { ...notes[index], text, updatedAt: Date.now() };
      await writeNotes(notes);
      return sendJson(res, 200, notes[index]);
    }

    if (req.method === "DELETE") {
      const notes = await readNotes();
      if (!notes.some((note) => note.id === id)) {
        return sendJson(res, 404, { error: "Note not found" });
      }

      await writeNotes(notes.filter((note) => note.id !== id));
      return sendJson(res, 200, { ok: true });
    }
  }

  return sendJson(res, 404, { error: "Endpoint not found" });
}

async function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  let requested;
  try {
    requested = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: "Invalid path" });
  }

  if (requested === "/" || requested === "") requested = "/index.html";

  const resolved = path.resolve(distDir, `.${requested}`);
  if (resolved !== distDir && !resolved.startsWith(`${distDir}${path.sep}`)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }

  try {
    const data = await fs.readFile(resolved);
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(resolved)] || "application/octet-stream",
    });
    return res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    try {
      const data = await fs.readFile(path.join(distDir, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      return sendJson(res, 404, { error: "Not found" });
    }
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/health") {
    return sendJson(res, 200, { status: "ok" });
  }

  if (url.pathname.startsWith("/api/")) {
    try {
      return await handleApi(req, res, url.pathname);
    } catch {
      return sendJson(res, 500, { error: "Internal server error" });
    }
  }

  try {
    return await serveStatic(req, res, url.pathname);
  } catch {
    return sendJson(res, 500, { error: "Internal server error" });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
