import { buildPushHTTPRequest } from "@pushforge/builder";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNotificationSweep(env));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/run") {
      await runNotificationSweep(env);
      return new Response("Notification sweep ran. Check Worker logs for details.");
    }
    return new Response("Nimbus notification worker is running.");
  },
};

async function sbFetch(env, path, options = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  return res;
}

async function runNotificationSweep(env) {
  const subsRes = await sbFetch(env, "push_subscriptions?select=*");
  if (!subsRes.ok) {
    console.error("Failed to fetch push_subscriptions", await subsRes.text());
    return;
  }
  const subs = await subsRes.json();
  if (!Array.isArray(subs) || !subs.length) return;

  const vapid = {
    privateJWK: JSON.parse(env.VAPID_PRIVATE_JWK),
    adminContact: env.VAPID_SUBJECT,
  };

  for (const sub of subs) {
    try {
      await processSubscription(env, sub, vapid);
    } catch (e) {
      console.error("Error processing subscription for", sub.user_id, e);
    }
  }
}

async function processSubscription(env, sub, vapid) {
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
      await sendPush(env, vapid, sub, {
        title: "☁️ Daily Check-In",
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
      await sendPush(env, vapid, sub, {
        title: `📋 ${due.length} task${due.length > 1 ? "s" : ""} due today`,
        body: show.slice(0, 2).map(t => t.name).join(", "),
        data: { type: "task", id: show[0].id },
      });
      await patchSub(env, sub.user_id, { last_task_push_date: todayLocal });
    }
  }
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

async function sendPush(env, vapid, sub, { title, body, data }) {
  const subscription = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.p256dh, auth: sub.auth },
  };
  const message = {
    payload: {
      title,
      body,
      tag: "nimbus-" + (data?.type || "push"),
      data,
    },
    adminContact: vapid.adminContact,
  };
  const { endpoint, headers, body: pushBody } = await buildPushHTTPRequest({
    privateJWK: vapid.privateJWK,
    subscription,
    message,
  });
  const res = await fetch(endpoint, { method: "POST", headers, body: pushBody });
  if (res.status === 404 || res.status === 410) {
    await sbFetch(env, `push_subscriptions?user_id=eq.${sub.user_id}`, { method: "DELETE" });
  } else if (!res.ok) {
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