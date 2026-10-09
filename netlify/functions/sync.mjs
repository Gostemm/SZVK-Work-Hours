import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const TOKEN_SECRET = process.env.AUTH_SECRET || "szvk_work_hours_secure_token_secret_key_v1_2026_xyz981";
const SUPER_ADMIN_USERNAME = "artem";
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || ",:Mz1N:IyS\\Q4i{";

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

function hashPassword(plain) {
  if (!plain) return "";
  const hash = crypto.createHash("sha256").update(String(plain)).digest("hex");
  return `sha256:${hash}`;
}

function verifyPassword(stored, entered) {
  if (!stored || !entered) return false;
  const enteredStr = String(entered);
  if (typeof stored === "string" && stored.startsWith("sha256:")) {
    const hash = crypto.createHash("sha256").update(enteredStr).digest("hex");
    return stored === `sha256:${hash}`;
  }
  // Fallback for legacy plain text:
  return String(stored) === enteredStr;
}

function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", TOKEN_SECRET).update(data).digest("base64url");
  return `${data}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, signature] = parts;
  try {
    const expectedSig = crypto.createHmac("sha256", TOKEN_SECRET).update(data).digest("base64url");
    if (signature.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf-8"));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function getAuthenticatedUser(req) {
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return verifyToken(match[1]);
}

export default async (req, context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }

  let store;
  try {
    store = getStore({
      name: "szvk-store",
      consistency: "strong"
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Failed to initialize store: " + err.message }), {
      status: 500,
      headers: CORS_HEADERS
    });
  }

  // 1. PUBLIC ACTION: LOGIN
  if (req.method === "POST") {
    let incoming;
    try {
      incoming = await req.json();
    } catch (e) {
      incoming = {};
    }

    if (incoming.action === "login") {
      const username = (incoming.username || "").trim();
      const password = incoming.password || "";

      if (!username || !password) {
        return new Response(JSON.stringify({ error: "Введіть логін та пароль" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      let existing = {};
      try {
        existing = (await store.get("app_state", { type: "json" })) || {};
      } catch (e) {
        existing = {};
      }

      const uLower = username.toLowerCase();

      // Check Super Admin
      if (uLower === SUPER_ADMIN_USERNAME) {
        const adminStoredPwd = existing.adminPasswordHash || SUPER_ADMIN_PASSWORD;
        if (verifyPassword(adminStoredPwd, password)) {
          const userPayload = {
            username: "Artem",
            name: "Артем",
            role: "admin",
            exp: Date.now() + 30 * 24 * 3600 * 1000
          };
          const token = signToken(userPayload);
          return new Response(JSON.stringify({
            success: true,
            token,
            user: { username: "Artem", name: "Артем", role: "admin" }
          }), { status: 200, headers: CORS_HEADERS });
        }
      }

      // Check Custom Users
      const users = existing.customUsers || {};
      let matchedKey = null;
      let matchedUser = null;

      for (const [k, u] of Object.entries(users)) {
        if ((u.username || "").trim().toLowerCase() === uLower) {
          matchedKey = k;
          matchedUser = u;
          break;
        }
      }

      if (matchedUser) {
        if (matchedUser.active === false) {
          return new Response(JSON.stringify({ error: "Акаунт деактивовано адміністратором" }), {
            status: 403,
            headers: CORS_HEADERS
          });
        }

        if (verifyPassword(matchedUser.password, password)) {
          // Transparent upgrade of legacy plaintext password to secure SHA-256 hash
          if (typeof matchedUser.password === "string" && !matchedUser.password.startsWith("sha256:")) {
            matchedUser.password = hashPassword(password);
            try {
              await store.setJSON("app_state", existing);
            } catch (err) {}
          }

          const userPayload = {
            username: matchedUser.username,
            name: matchedUser.name || matchedUser.username,
            role: matchedUser.role || "editor",
            exp: Date.now() + 30 * 24 * 3600 * 1000
          };
          const token = signToken(userPayload);
          return new Response(JSON.stringify({
            success: true,
            token,
            user: {
              username: matchedUser.username,
              name: matchedUser.name || matchedUser.username,
              role: matchedUser.role || "editor"
            }
          }), { status: 200, headers: CORS_HEADERS });
        }
      }

      return new Response(JSON.stringify({ error: "Невірний логін або пароль" }), {
        status: 401,
        headers: CORS_HEADERS
      });
    }

    // All other POST actions require authentication!
    const sessionUser = getAuthenticatedUser(req);
    if (!sessionUser) {
      return new Response(JSON.stringify({ error: "Потрібна авторизація. Доступ заборонено." }), {
        status: 401,
        headers: CORS_HEADERS
      });
    }

    let existing = {};
    try {
      existing = (await store.get("app_state", { type: "json" })) || {};
    } catch (e) {
      existing = {};
    }
    existing.customUsers = existing.customUsers || {};

    // ADMIN ACTION: Save/Create User
    if (incoming.action === "saveUser") {
      if (sessionUser.role !== "admin") {
        return new Response(JSON.stringify({ error: "Тільки адміністратор має право змінювати користувачів" }), {
          status: 403,
          headers: CORS_HEADERS
        });
      }

      const target = incoming.targetUser;
      if (!target || !target.username) {
        return new Response(JSON.stringify({ error: "Невірні дані користувача" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      const rawU = target.username.trim();
      const key = rawU.toLowerCase().replace(/[^a-z0-9_]/g, "_");
      if (key === SUPER_ADMIN_USERNAME) {
        return new Response(JSON.stringify({ error: "Логін 'Artem' зарезервовано для головного адміністратора" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      const prev = existing.customUsers[key] || {};
      const pwdHash = target.password ? hashPassword(target.password) : (prev.password || "");

      if (!pwdHash) {
        return new Response(JSON.stringify({ error: "Пароль обов'язковий" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      existing.customUsers[key] = {
        username: rawU,
        name: target.name ? target.name.trim() : rawU,
        role: target.role || "editor",
        active: target.active !== false,
        password: pwdHash
      };
      existing.updatedAt = Date.now();

      await store.setJSON("app_state", existing);
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: CORS_HEADERS
      });
    }

    // ADMIN ACTION: Toggle User Active
    if (incoming.action === "toggleUserActive") {
      if (sessionUser.role !== "admin") {
        return new Response(JSON.stringify({ error: "Доступ заборонено" }), { status: 403, headers: CORS_HEADERS });
      }

      const rawU = (incoming.username || "").trim();
      const key = rawU.toLowerCase().replace(/[^a-z0-9_]/g, "_");
      if (existing.customUsers[key]) {
        existing.customUsers[key].active = !existing.customUsers[key].active;
        existing.updatedAt = Date.now();
        await store.setJSON("app_state", existing);
        return new Response(JSON.stringify({ success: true, active: existing.customUsers[key].active }), {
          status: 200,
          headers: CORS_HEADERS
        });
      }
      return new Response(JSON.stringify({ error: "Користувача не знайдено" }), { status: 404, headers: CORS_HEADERS });
    }

    // ADMIN ACTION: Delete User
    if (incoming.action === "deleteUser") {
      if (sessionUser.role !== "admin") {
        return new Response(JSON.stringify({ error: "Доступ заборонено" }), { status: 403, headers: CORS_HEADERS });
      }

      const rawU = (incoming.username || "").trim();
      const key = rawU.toLowerCase().replace(/[^a-z0-9_]/g, "_");
      if (existing.customUsers[key]) {
        delete existing.customUsers[key];
        existing.updatedAt = Date.now();
        await store.setJSON("app_state", existing);
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: CORS_HEADERS });
      }
      return new Response(JSON.stringify({ error: "Користувача не знайдено" }), { status: 404, headers: CORS_HEADERS });
    }

    // ADMIN OR SELF: Change Password
    if (incoming.action === "changePassword") {
      const rawU = (incoming.username || "").trim();
      const newPwd = incoming.newPassword || "";
      if (!newPwd || newPwd.length < 3) {
        return new Response(JSON.stringify({ error: "Пароль має містити щонайменше 3 символи" }), {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      const isSelf = sessionUser.username.toLowerCase() === rawU.toLowerCase();
      const isAdmin = sessionUser.role === "admin";
      if (!isAdmin && !isSelf) {
        return new Response(JSON.stringify({ error: "Доступ заборонено" }), { status: 403, headers: CORS_HEADERS });
      }

      if (rawU.toLowerCase() === SUPER_ADMIN_USERNAME) {
        existing.adminPasswordHash = hashPassword(newPwd);
        existing.updatedAt = Date.now();
        await store.setJSON("app_state", existing);
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: CORS_HEADERS });
      }

      const key = rawU.toLowerCase().replace(/[^a-z0-9_]/g, "_");
      if (existing.customUsers[key]) {
        existing.customUsers[key].password = hashPassword(newPwd);
        existing.updatedAt = Date.now();
        await store.setJSON("app_state", existing);
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: CORS_HEADERS });
      }
      return new Response(JSON.stringify({ error: "Користувача не знайдено" }), { status: 404, headers: CORS_HEADERS });
    }

    // STANDARD DATA SYNC (Schedule, Trackers Data)
    const merged = {
      ...existing,
      schedule: incoming.schedule !== undefined ? incoming.schedule : (existing.schedule || {}),
      trackersData: incoming.trackersData !== undefined ? incoming.trackersData : (existing.trackersData || null),
      updatedAt: Date.now()
    };
    // Ensure customUsers are not wiped or overridden by normal sync
    merged.customUsers = existing.customUsers || {};

    await store.setJSON("app_state", merged);
    return new Response(JSON.stringify({ success: true, updatedAt: merged.updatedAt }), {
      status: 200,
      headers: CORS_HEADERS
    });
  }

  // 2. PROTECTED ACTION: GET
  if (req.method === "GET") {
    const sessionUser = getAuthenticatedUser(req);
    if (!sessionUser) {
      return new Response(JSON.stringify({ error: "Потрібна авторизація. Доступ заборонено." }), {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          "Cache-Control": "no-store, no-cache, must-revalidate"
        }
      });
    }

    try {
      const data = (await store.get("app_state", { type: "json" })) || {};
      const responseData = {
        schedule: data.schedule || {},
        trackersData: data.trackersData || null,
        updatedAt: data.updatedAt || Date.now()
      };

      // If and ONLY if the user is an admin, return the user list.
      // CRITICAL: NEVER include the password field in the response!
      if (sessionUser.role === "admin") {
        const sanitizedUsers = {};
        for (const [k, u] of Object.entries(data.customUsers || {})) {
          sanitizedUsers[k] = {
            username: u.username,
            name: u.name,
            role: u.role || "editor",
            active: u.active !== false
          };
        }
        responseData.customUsers = sanitizedUsers;
      }

      return new Response(JSON.stringify(responseData), {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "Cache-Control": "no-store, no-cache, must-revalidate"
        }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: CORS_HEADERS
      });
    }
  }

  return new Response("Method Not Allowed", {
    status: 405,
    headers: {
      "Content-Type": "text/plain",
      "Access-Control-Allow-Origin": "*"
    }
  });
};
