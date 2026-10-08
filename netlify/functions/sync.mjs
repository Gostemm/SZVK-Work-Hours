import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
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
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }

  if (req.method === "GET") {
    try {
      const data = await store.get("app_state", { type: "json" });
      return new Response(JSON.stringify(data || {}), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store, no-cache, must-revalidate"
        }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
  }

  if (req.method === "POST") {
    try {
      const incoming = await req.json();
      let existing = {};
      try {
        existing = (await store.get("app_state", { type: "json" })) || {};
      } catch (e) {
        existing = {};
      }

      const merged = {
        ...existing,
        ...incoming,
        customUsers: incoming.customUsers !== undefined ? incoming.customUsers : (existing.customUsers || {}),
        schedule: incoming.schedule !== undefined ? incoming.schedule : (existing.schedule || {}),
        trackersData: incoming.trackersData !== undefined ? incoming.trackersData : (existing.trackersData || null),
        updatedAt: Date.now()
      };

      await store.setJSON("app_state", merged);
      return new Response(JSON.stringify({ success: true, updatedAt: merged.updatedAt }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
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
