import { buildPushHTTPRequest } from "@pushforge/builder";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNotificationSweep(env));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (url.pathname === "/api/push/test" && req.method === "POST") {
      try {
        const { user_id } = await req.json();
        const subRes = await sbFetch(env, `push_subscriptions?user_id=eq.${user_id}&select=*`);
        const rows = await subRes.json();
        if (!rows.length) {
          return json({ error: "No subscription found" }, 404, corsHeaders);
        }
        await sendPush(env, rows[0], {
          title: "Test push from Nimbus",
          body: "If you see this, push notifications are working!",
          data: { type: "test" },
        });
        return json({ success: true }, 200, corsHeaders);
      } catch (err) {
        return json({ error: err.message }, 500, corsHeaders);
      }
    }
    if (url.pathname === "/run") {
      await runNotificationSweep(env);
      return new Response("Notification sweep ran. Check Worker logs for details.");
    }
    return new Response("Nimbus notification worker is running.");
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function sbFetch(env, path, options = {}) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

async function runNotificationSweep(env) {
  const subsRes = await sbFetch(env, "push_subscriptions?select=*");
  if (!subsRes.ok) {
    console.error("Failed to fetch push_subscriptions", await subsRes.text());
    return;
  }
  const subs = await subsRes.json();
  if (!Array.isArray(subs) || !subs.length) return;

  for (const sub of subs) {
    try {
      await processSubscription(env, sub);
    } catch (e) {
      console.error("Error processing subscription for", sub.user_id, e);
    }
  }
}

async function processSubscription(env, sub) {
  const userRes = await sbFetch(env, `user_data?user_id=eq.${sub.user_id}&select=data`);
  if (!userRes.ok) return;
  const rows = await userRes.json();
  const data = rows?.[0]?.data;
  if (!data) return;

  const notifs = data.notifs || {};
  const tz = sub.timezone || "UTC";
  const nowLocal = getLocalParts(tz);
  const todayLocal = `${nowLocal.year}-${pad(nowLocal.month)}-${pad(nowLocal.day)}`;

  if (notifs.checkin && data.lastCI !== todayLocal && sub.last_checkin_push_date !== todayLocal) {
    const [ciH, ciM] = (notifs.checkinTime || "08:00").split(":").map(Number);
    if (isWithinWindow(nowLocal, ciH, ciM)) {
      await sendPush(env, sub, {
        title: "Daily Check-In",
        body: "How are you feeling today? Nimbus wants to know!",
        data: { type: "checkin" },
      });
      await patchSub(env, sub.user_id, { last_checkin_push_date: todayLocal });
      return;
    }
  }

  if (notifs.tasks && sub.last_task_push_date !== todayLocal && isWithinWindow(nowLocal, 9, 0)) {
    const due = (data.tasks || []).filter(t => !t.done && t.due === todayLocal);
    if (due.length) {
      const urgent = due.filter(t => t.priority === "Urgent");
      const show = urgent.length ? urgent : due;
      await sendPush(env, sub, {
        title: `${due.length} task${due.length > 1 ? "s" : ""} due today`,
        body: show.slice(0, 2).map(t => t.name).join(", "),
        data: { type: "task", id: show[0].id },
      });
      await patchSub(env, sub.user_id, { last_task_push_date: todayLocal });
    }
  }

  if (notifs.break) {
    const breakMins = getBreakMins(data);
    const intervalMs = breakMins * 60 * 1000;
    const lastBreakClientMs = data.lastBreakAt ? new Date(data.lastBreakAt).getTime() : 0;
    const lastPushMs = sub.last_break_push_at ? new Date(sub.last_break_push_at).getTime() : 0;
    const nowMs = Date.now();
    const sinceBreak = nowMs - lastBreakClientMs;
    const sincePush = nowMs - lastPushMs;
    const repeatGate = notifs.escalate ? intervalMs / 2 : intervalMs;
    if (sinceBreak >= intervalMs && sincePush >= repeatGate) {
      await sendPush(env, sub, {
        title: "Time for a break!",
        body: "You've been going for a while. Step away for a bit.",
        data: { type: "break" },
      });
      await patchSub(env, sub.user_id, { last_break_push_at: new Date(nowMs).toISOString() });
    }
  }
}

function getBreakMins(data) {
  const overwhelm = data.overwhelm ?? 5;
  const workload = data.workload ?? 5;
  const avg = (overwhelm + workload) / 2;
  if (avg >= 8.5) return 20;
  if (avg >= 7) return 30;
  if (avg >= 5) return 45;
  return (data.notifs && data.notifs.breakFreq) || 60;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function getLocalParts(tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    minute: Number(parts.minute),
  };
}

function isWithinWindow(nowLocal, targetH, targetM) {
  const nowMin = nowLocal.hour * 60 + nowLocal.minute;
  const targetMin = targetH * 60 + targetM;
  return nowMin >= targetMin && nowMin < targetMin + 15;
}

async function sendPush(env, sub, { title, body, data }) {
  const subscription = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.p256dh, auth: sub.auth },
  };
  const message = {
    payload: { title, body, ...(data ? { data } : {}) },
    options: { ttl: 3600, urgency: "normal" },
    adminContact: env.VAPID_SUBJECT,
  };
  const { endpoint, headers, body: pushBody } = await buildPushHTTPRequest({
    privateJWK: JSON.parse(env.VAPID_PRIVATE_JWK),
    message,
    subscription,
  });
  const res = await fetch(endpoint, { method: "POST", headers, body: pushBody });
  if (res.status === 404 || res.status === 410) {
    await sbFetch(env, `push_subscriptions?user_id=eq.${sub.user_id}`, { method: "DELETE" });
  } else if (!res.ok && res.status !== 201) {
    console.error("Push send failed", res.status, await res.text());
  }
}

async function patchSub(env, userId, fields) {
  await sbFetch(env, `push_subscriptions?user_id=eq.${userId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(fields),
  });
}
