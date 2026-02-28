import { renderAppShell } from "./ui.js";

const COOKIE_NAME = "nm_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const DEFAULT_MAX_USERS = 30;
const DEFAULT_MAX_KEYWORDS_PER_USER = 40;

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      console.error("Unhandled error", error);
      return jsonResponse({ error: "Internal Server Error" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPoll(env, "cron"));
  },
};

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === "/") {
    return new Response(renderAppShell(), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  if (path === "/favicon.ico") {
    return new Response(null, { status: 204 });
  }

  if (path === "/api/bootstrap-status" && method === "GET") {
    const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first();
    return jsonResponse({
      hasUsers: Number(countRow?.count || 0) > 0,
      appMode: getAppMode(env),
      maxUsers: getMaxUsers(env),
      maxKeywordsPerUser: getMaxKeywordsPerUser(env),
    });
  }

  if (path === "/api/bootstrap-admin" && method === "POST") {
    return handleBootstrapAdmin(request, env);
  }

  if (path === "/api/login" && method === "POST") {
    return handleLogin(request, env);
  }

  if (path === "/api/logout" && method === "POST") {
    return handleLogout(request);
  }

  if (path === "/api/me" && method === "GET") {
    const session = await getSessionFromRequest(request, env);
    if (!session) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    return jsonResponse({ user: session.user });
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  if (path === "/api/keywords" && method === "GET") {
    return listKeywords(env, session.user);
  }
  if (path === "/api/keywords" && method === "POST") {
    return createKeyword(request, env, session.user);
  }

  const keywordMatch = path.match(/^\/api\/keywords\/([^/]+)$/);
  if (keywordMatch && method === "PATCH") {
    return patchKeyword(request, env, session.user, keywordMatch[1]);
  }
  if (keywordMatch && method === "DELETE") {
    return deleteKeyword(env, session.user, keywordMatch[1]);
  }

  if (path === "/api/channels" && method === "GET") {
    return listChannels(env, session.user);
  }
  if (path === "/api/channels" && method === "POST") {
    return createChannel(request, env, session.user);
  }

  const channelMatch = path.match(/^\/api\/channels\/([^/]+)$/);
  if (channelMatch && method === "PATCH") {
    return patchChannel(request, env, session.user, channelMatch[1]);
  }
  if (channelMatch && method === "DELETE") {
    return deleteChannel(env, session.user, channelMatch[1]);
  }

  if (path === "/api/users" && method === "GET") {
    return listUsers(env, session.user);
  }
  if (path === "/api/users" && method === "POST") {
    return createUser(request, env, session.user);
  }

  if (path === "/api/poll-runs" && method === "GET") {
    return listPollRuns(env, session.user);
  }

  if (path === "/api/run-now" && method === "POST") {
    if (session.user.role !== "admin") {
      return jsonResponse({ error: "Admin only" }, 403);
    }
    const result = await runPoll(env, "manual");
    return jsonResponse({ ok: true, result });
  }

  return jsonResponse({ error: "Not found" }, 404);
}

async function handleBootstrapAdmin(request, env) {
  const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first();
  if (Number(countRow?.count || 0) > 0) {
    return jsonResponse({ error: "Admin is already initialized" }, 409);
  }

  const body = await readJson(request);
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!name || !isValidEmail(email) || password.length < 8) {
    return jsonResponse({ error: "Invalid name/email/password" }, 400);
  }

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);

  await env.DB.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, active) VALUES (?, ?, ?, ?, 'admin', 1)",
  )
    .bind(id, email, name, passwordHash)
    .run();

  return jsonResponse({ ok: true });
}

async function handleLogin(request, env) {
  const body = await readJson(request);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!isValidEmail(email) || !password) {
    return jsonResponse({ error: "Invalid credentials" }, 400);
  }

  const row = await env.DB.prepare(
    "SELECT id, email, name, role, active, password_hash FROM users WHERE email = ? LIMIT 1",
  )
    .bind(email)
    .first();

  if (!row || Number(row.active) !== 1) {
    return jsonResponse({ error: "Invalid credentials" }, 401);
  }

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) {
    return jsonResponse({ error: "Invalid credentials" }, 401);
  }

  const token = await signSessionToken(
    {
      uid: row.id,
      role: row.role,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    },
    getSessionSecret(env),
  );

  const secure = new URL(request.url).protocol === "https:";
  return jsonResponse(
    { ok: true, user: { id: row.id, email: row.email, name: row.name, role: row.role } },
    200,
    {
      "set-cookie": buildCookie(COOKIE_NAME, token, SESSION_TTL_SECONDS, secure),
    },
  );
}

async function handleLogout(request) {
  const secure = new URL(request.url).protocol === "https:";
  return jsonResponse(
    { ok: true },
    200,
    {
      "set-cookie": buildCookie(COOKIE_NAME, "", 0, secure),
    },
  );
}

async function getSessionFromRequest(request, env) {
  let token;
  const cookie = request.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${COOKIE_NAME}=`)) {
      token = trimmed.slice(COOKIE_NAME.length + 1);
      break;
    }
  }

  if (!token) return null;

  const payload = await verifySessionToken(token, getSessionSecret(env));
  if (!payload?.uid || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  const user = await env.DB.prepare(
    "SELECT id, email, name, role, active FROM users WHERE id = ? LIMIT 1",
  )
    .bind(payload.uid)
    .first();

  if (!user || Number(user.active) !== 1) return null;

  return { user };
}

async function listKeywords(env, user) {
  const params = [];
  let sql = "SELECT id, user_id, label, query, exclude_terms, source, active, created_at, updated_at FROM keywords";

  if (user.role !== "admin") {
    sql += " WHERE user_id = ?";
    params.push(user.id);
  }

  sql += " ORDER BY created_at DESC";

  const res = params.length
    ? await env.DB.prepare(sql).bind(...params).all()
    : await env.DB.prepare(sql).all();

  const keywords = (res.results || []).map((row) => ({
    ...row,
    active: Number(row.active) === 1,
    exclude_terms: safeJsonArray(row.exclude_terms),
  }));

  return jsonResponse({ keywords });
}

async function createKeyword(request, env, user) {
  const body = await readJson(request);
  const label = String(body.label || "").trim();
  const query = String(body.query || "").trim();
  const source = String(body.source || "google_rss").trim();
  const excludeTerms = Array.isArray(body.excludeTerms)
    ? body.excludeTerms.map((x) => String(x).trim()).filter(Boolean)
    : [];

  if (!label || !query) {
    return jsonResponse({ error: "label and query are required" }, 400);
  }

  if (source !== "google_rss") {
    return jsonResponse({ error: "Only google_rss source is supported in MVP" }, 400);
  }

  const userId = user.role === "admin" && body.userId ? String(body.userId) : user.id;
  if (user.role !== "admin" && userId !== user.id) {
    return jsonResponse({ error: "Cannot create keyword for another user" }, 403);
  }

  const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM keywords WHERE user_id = ?")
    .bind(userId)
    .first();
  if (Number(countRow?.count || 0) >= getMaxKeywordsPerUser(env)) {
    return jsonResponse({ error: `Keyword limit reached (${getMaxKeywordsPerUser(env)})` }, 403);
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO keywords (id, user_id, label, query, exclude_terms, source, active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  )
    .bind(id, userId, label, query, JSON.stringify(excludeTerms), source)
    .run();

  return jsonResponse({ ok: true, id });
}

async function patchKeyword(request, env, user, keywordId) {
  const row = await env.DB.prepare("SELECT id, user_id FROM keywords WHERE id = ? LIMIT 1")
    .bind(keywordId)
    .first();
  if (!row) return jsonResponse({ error: "Keyword not found" }, 404);
  if (user.role !== "admin" && row.user_id !== user.id) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }

  const body = await readJson(request);
  const fields = [];
  const params = [];

  if (body.label !== undefined) {
    fields.push("label = ?");
    params.push(String(body.label || "").trim());
  }
  if (body.query !== undefined) {
    fields.push("query = ?");
    params.push(String(body.query || "").trim());
  }
  if (body.excludeTerms !== undefined) {
    const excludeTerms = Array.isArray(body.excludeTerms)
      ? body.excludeTerms.map((x) => String(x).trim()).filter(Boolean)
      : [];
    fields.push("exclude_terms = ?");
    params.push(JSON.stringify(excludeTerms));
  }
  if (body.active !== undefined) {
    fields.push("active = ?");
    params.push(Number(body.active) ? 1 : 0);
  }

  if (!fields.length) {
    return jsonResponse({ error: "No patch field" }, 400);
  }

  fields.push("updated_at = datetime('now')");
  params.push(keywordId);

  await env.DB.prepare(`UPDATE keywords SET ${fields.join(", ")} WHERE id = ?`).bind(...params).run();

  return jsonResponse({ ok: true });
}

async function deleteKeyword(env, user, keywordId) {
  const row = await env.DB.prepare("SELECT id, user_id FROM keywords WHERE id = ? LIMIT 1")
    .bind(keywordId)
    .first();
  if (!row) return jsonResponse({ error: "Keyword not found" }, 404);
  if (user.role !== "admin" && row.user_id !== user.id) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }

  await env.DB.prepare("DELETE FROM keywords WHERE id = ?").bind(keywordId).run();
  return jsonResponse({ ok: true });
}

async function listChannels(env, user) {
  const params = [];
  let sql = "SELECT id, user_id, name, type, webhook_url, active, created_at, updated_at FROM channels";

  if (user.role !== "admin") {
    sql += " WHERE user_id = ?";
    params.push(user.id);
  }

  sql += " ORDER BY created_at DESC";

  const res = params.length
    ? await env.DB.prepare(sql).bind(...params).all()
    : await env.DB.prepare(sql).all();

  const channels = (res.results || []).map((row) => ({
    ...row,
    active: Number(row.active) === 1,
  }));

  return jsonResponse({ channels });
}

async function createChannel(request, env, user) {
  const body = await readJson(request);
  const name = String(body.name || "").trim();
  const requestedType = String(body.type || "teams").trim().toLowerCase();
  const appMode = getAppMode(env);
  const type = appMode === "single_user_slack" ? "slack" : requestedType;
  const webhookUrl = String(body.webhookUrl || "").trim();

  if (!name || !isValidWebhook(webhookUrl)) {
    return jsonResponse({ error: "Invalid channel name or webhook URL" }, 400);
  }

  if (!["teams", "slack"].includes(type)) {
    return jsonResponse({ error: "channel type must be teams/slack" }, 400);
  }

  if (appMode === "single_user_slack" && type !== "slack") {
    return jsonResponse({ error: "single_user_slack mode only allows slack" }, 403);
  }

  const userId = user.role === "admin" && body.userId ? String(body.userId) : user.id;
  if (user.role !== "admin" && userId !== user.id) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO channels (id, user_id, name, type, webhook_url, active)
     VALUES (?, ?, ?, ?, ?, 1)`,
  )
    .bind(id, userId, name, type, webhookUrl)
    .run();

  return jsonResponse({ ok: true, id });
}

async function patchChannel(request, env, user, channelId) {
  const row = await env.DB.prepare("SELECT id, user_id FROM channels WHERE id = ? LIMIT 1")
    .bind(channelId)
    .first();
  if (!row) return jsonResponse({ error: "Channel not found" }, 404);
  if (user.role !== "admin" && row.user_id !== user.id) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }

  const body = await readJson(request);
  const fields = [];
  const params = [];

  if (body.name !== undefined) {
    fields.push("name = ?");
    params.push(String(body.name || "").trim());
  }
  if (body.webhookUrl !== undefined) {
    const webhookUrl = String(body.webhookUrl || "").trim();
    if (!isValidWebhook(webhookUrl)) {
      return jsonResponse({ error: "Invalid webhook URL" }, 400);
    }
    fields.push("webhook_url = ?");
    params.push(webhookUrl);
  }
  if (body.active !== undefined) {
    fields.push("active = ?");
    params.push(Number(body.active) ? 1 : 0);
  }

  if (!fields.length) {
    return jsonResponse({ error: "No patch field" }, 400);
  }

  fields.push("updated_at = datetime('now')");
  params.push(channelId);

  await env.DB.prepare(`UPDATE channels SET ${fields.join(", ")} WHERE id = ?`).bind(...params).run();

  return jsonResponse({ ok: true });
}

async function deleteChannel(env, user, channelId) {
  const row = await env.DB.prepare("SELECT id, user_id FROM channels WHERE id = ? LIMIT 1")
    .bind(channelId)
    .first();
  if (!row) return jsonResponse({ error: "Channel not found" }, 404);
  if (user.role !== "admin" && row.user_id !== user.id) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }

  await env.DB.prepare("DELETE FROM channels WHERE id = ?").bind(channelId).run();
  return jsonResponse({ ok: true });
}

async function listUsers(env, user) {
  if (user.role !== "admin") {
    return jsonResponse({ error: "Admin only" }, 403);
  }

  const res = await env.DB.prepare(
    "SELECT id, name, email, role, active, created_at FROM users ORDER BY created_at DESC",
  ).all();

  const users = (res.results || []).map((row) => ({
    ...row,
    active: Number(row.active) === 1,
  }));

  return jsonResponse({ users });
}

async function createUser(request, env, user) {
  if (user.role !== "admin") {
    return jsonResponse({ error: "Admin only" }, 403);
  }

  if (getAppMode(env) === "single_user_slack") {
    return jsonResponse({ error: "single_user_slack mode does not allow additional users" }, 403);
  }

  const userCountRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE active = 1").first();
  if (Number(userCountRow?.count || 0) >= getMaxUsers(env)) {
    return jsonResponse({ error: `User limit reached (${getMaxUsers(env)})` }, 403);
  }

  const body = await readJson(request);
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!name || !isValidEmail(email) || password.length < 8) {
    return jsonResponse({ error: "Invalid name/email/password" }, 400);
  }

  const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ? LIMIT 1").bind(email).first();
  if (exists) {
    return jsonResponse({ error: "Email already exists" }, 409);
  }

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);

  await env.DB.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, active) VALUES (?, ?, ?, ?, 'user', 1)",
  )
    .bind(id, email, name, passwordHash)
    .run();

  return jsonResponse({ ok: true, id });
}

async function listPollRuns(env, user) {
  if (user.role !== "admin") {
    const res = await env.DB.prepare(
      `SELECT p.id, p.trigger_type, p.started_at, p.finished_at, p.status, p.fetched_count,
              p.new_article_count, p.queued_notifications, p.sent_notifications,
              p.failed_notifications, p.error_message
       FROM poll_runs p
       ORDER BY p.started_at DESC
       LIMIT 20`,
    ).all();
    return jsonResponse({ runs: res.results || [] });
  }

  const res = await env.DB.prepare(
    `SELECT id, trigger_type, started_at, finished_at, status, fetched_count,
            new_article_count, queued_notifications, sent_notifications,
            failed_notifications, error_message
     FROM poll_runs
     ORDER BY started_at DESC
     LIMIT 50`,
  ).all();

  return jsonResponse({ runs: res.results || [] });
}

async function runPoll(env, triggerType) {
  const db = env.DB;
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  await db.prepare(
    `INSERT INTO poll_runs (id, trigger_type, started_at, status)
     VALUES (?, ?, ?, 'running')`,
  )
    .bind(runId, triggerType, startedAt)
    .run();

  let fetchedCount = 0;
  let newArticleCount = 0;
  let queuedNotifications = 0;
  let sentNotifications = 0;
  let failedNotifications = 0;

  try {
    const keywordRows = await db.prepare(
      `SELECT k.id AS keyword_id, k.user_id, k.label, k.query, k.exclude_terms, k.source,
              c.id AS channel_id, c.type, c.webhook_url, c.name AS channel_name,
              u.name AS user_name, u.email AS user_email
       FROM keywords k
       JOIN users u ON u.id = k.user_id AND u.active = 1
       JOIN channels c ON c.user_id = u.id AND c.active = 1
       WHERE k.active = 1
       ORDER BY k.query ASC`,
    ).all();

    const rows = keywordRows.results || [];
    const groupedByQuery = groupKeywordRows(rows);

    for (const group of groupedByQuery.values()) {
      const articles = await fetchArticlesForQuery(env, group.source, group.query);
      fetchedCount += articles.length;

      for (const article of articles) {
        const articleId = await buildArticleId(article, group.query);
        const insertArticle = await db
          .prepare(
            `INSERT INTO articles (id, source, query, title, url, normalized_url, published_at, summary)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO NOTHING`,
          )
          .bind(
            articleId,
            group.source,
            group.query,
            article.title,
            article.url,
            article.normalizedUrl,
            article.publishedAt,
            article.summary,
          )
          .run();

        if (Number(insertArticle.meta?.changes || 0) > 0) {
          newArticleCount += 1;
        }

        for (const row of group.rows) {
          const excludeTerms = safeJsonArray(row.exclude_terms).map((x) => String(x).toLowerCase());
          if (isExcluded(article, excludeTerms)) {
            continue;
          }

          const insertNotif = await db
            .prepare(
              `INSERT INTO notifications (id, article_id, user_id, keyword_id, channel_id, status)
               VALUES (?, ?, ?, ?, ?, 'pending')
               ON CONFLICT(article_id, keyword_id, channel_id) DO NOTHING`,
            )
            .bind(
              crypto.randomUUID(),
              articleId,
              row.user_id,
              row.keyword_id,
              row.channel_id,
            )
            .run();

          if (Number(insertNotif.meta?.changes || 0) > 0) {
            queuedNotifications += 1;
          }
        }
      }
    }

    const pendingRows = await db.prepare(
      `SELECT n.id AS notification_id, n.channel_id,
              a.title, a.url, a.published_at,
              k.label AS keyword_label, k.query,
              c.type, c.webhook_url,
              u.name AS user_name
       FROM notifications n
       JOIN articles a ON a.id = n.article_id
       JOIN keywords k ON k.id = n.keyword_id
       JOIN channels c ON c.id = n.channel_id
       JOIN users u ON u.id = n.user_id
       WHERE n.status = 'pending'
       ORDER BY n.created_at ASC`,
    ).all();

    const groupedByChannel = groupByChannel(pendingRows.results || []);
    for (const batch of groupedByChannel.values()) {
      const first = batch[0];
      const sendResult = first.type === "slack"
        ? await sendSlackWebhook(first.webhook_url, batch)
        : await sendTeamsWebhook(first.webhook_url, batch);

      if (sendResult.ok) {
        sentNotifications += batch.length;
        await markNotifications(db, batch.map((x) => x.notification_id), "sent", null);
      } else {
        failedNotifications += batch.length;
        await markNotifications(db, batch.map((x) => x.notification_id), "failed", sendResult.error);
      }
    }

    await db.prepare(
      `UPDATE poll_runs
       SET finished_at = ?, status = 'success', fetched_count = ?, new_article_count = ?,
           queued_notifications = ?, sent_notifications = ?, failed_notifications = ?
       WHERE id = ?`,
    )
      .bind(
        new Date().toISOString(),
        fetchedCount,
        newArticleCount,
        queuedNotifications,
        sentNotifications,
        failedNotifications,
        runId,
      )
      .run();

    return {
      runId,
      triggerType,
      fetchedCount,
      newArticleCount,
      queuedNotifications,
      sentNotifications,
      failedNotifications,
    };
  } catch (error) {
    const message = String(error?.message || error);
    await db.prepare(
      `UPDATE poll_runs
       SET finished_at = ?, status = 'failed', fetched_count = ?, new_article_count = ?,
           queued_notifications = ?, sent_notifications = ?, failed_notifications = ?, error_message = ?
       WHERE id = ?`,
    )
      .bind(
        new Date().toISOString(),
        fetchedCount,
        newArticleCount,
        queuedNotifications,
        sentNotifications,
        failedNotifications,
        message.slice(0, 900),
        runId,
      )
      .run();

    console.error("poll failed", error);
    throw error;
  }
}

function groupKeywordRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.source}::${row.query}`;
    if (!map.has(key)) {
      map.set(key, { source: row.source, query: row.query, rows: [] });
    }
    map.get(key).rows.push(row);
  }
  return map;
}

function groupByChannel(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.channel_id)) {
      map.set(row.channel_id, []);
    }
    map.get(row.channel_id).push(row);
  }
  return map;
}

async function fetchArticlesForQuery(env, source, query) {
  if (source !== "google_rss") {
    return [];
  }

  const lang = (env.GOOGLE_NEWS_LANG || "ko").trim();
  const region = (env.GOOGLE_NEWS_REGION || "KR").trim();
  const edition = (env.GOOGLE_NEWS_EDITION || "KR:ko").trim();
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(lang)}&gl=${encodeURIComponent(region)}&ceid=${encodeURIComponent(edition)}`;

  const res = await fetch(url, { cf: { cacheTtl: 0, cacheEverything: false } });
  if (!res.ok) {
    throw new Error(`google_rss fetch failed (${res.status})`);
  }

  const xml = await res.text();
  const parsed = parseRssItems(xml)
    .filter((item) => item.title && item.url)
    .slice(0, 20);

  return parsed;
}

function parseRssItems(xmlText) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xmlText)) !== null) {
    const raw = match[1];
    const title = decodeEntities(stripCdata(getTagValue(raw, "title")));
    const link = decodeEntities(stripCdata(getTagValue(raw, "link")));
    const description = stripHtml(decodeEntities(stripCdata(getTagValue(raw, "description"))));
    const pubDateRaw = stripCdata(getTagValue(raw, "pubDate"));

    items.push({
      title: collapseSpace(title),
      url: link.trim(),
      normalizedUrl: normalizeUrl(link),
      summary: collapseSpace(description).slice(0, 500),
      publishedAt: toIsoDate(pubDateRaw),
    });
  }

  return items;
}

function getTagValue(text, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = text.match(regex);
  return match ? match[1] : "";
}

function stripCdata(value) {
  return String(value || "")
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&nbsp;", " ");
}

function collapseSpace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function toIsoDate(input) {
  if (!input) return null;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return raw;

  try {
    const url = new URL(raw);

    if (url.searchParams.has("url")) {
      const target = url.searchParams.get("url");
      if (target && /^https?:\/\//i.test(target)) {
        return normalizeUrl(target);
      }
    }

    const keys = [...url.searchParams.keys()];
    for (const key of keys) {
      if (key.startsWith("utm_") || ["fbclid", "gclid", "ocid", "ref", "feature"].includes(key)) {
        url.searchParams.delete(key);
      }
    }

    url.hash = "";
    return url.toString();
  } catch {
    return raw;
  }
}

function isExcluded(article, excludeTerms) {
  if (!excludeTerms?.length) return false;
  const haystack = `${article.title} ${article.summary}`.toLowerCase();
  return excludeTerms.some((term) => term && haystack.includes(term));
}

async function buildArticleId(article, query) {
  const base = `${query}||${article.normalizedUrl || article.url}||${article.title}||${article.publishedAt || ""}`;
  const hash = await sha256Hex(base);
  return hash.slice(0, 32);
}

async function markNotifications(db, notificationIds, status, errorMessage) {
  if (!notificationIds.length) return;
  const now = new Date().toISOString();

  const statements = notificationIds.map((id) =>
    db
      .prepare(
        `UPDATE notifications
         SET status = ?, error_message = ?, sent_at = ?
         WHERE id = ?`,
      )
      .bind(status, errorMessage ? String(errorMessage).slice(0, 900) : null, status === "sent" ? now : null, id),
  );

  await db.batch(statements);
}

async function sendTeamsWebhook(webhookUrl, batch) {
  const title = `뉴스 알림 ${batch.length}건`;
  const lines = batch.slice(0, 20).map((item, index) => {
    const stamp = item.published_at ? ` (${new Date(item.published_at).toLocaleString("ko-KR")})` : "";
    return `${index + 1}. [${item.keyword_label}] ${item.title}${stamp}\n${item.url}`;
  });
  const text = `${title}\n\n${lines.join("\n\n")}`;

  const legacyPayload = { text };
  const legacy = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(legacyPayload),
  });

  if (legacy.ok) {
    return { ok: true };
  }

  const adaptivePayload = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true },
            ...batch.slice(0, 20).map((item, index) => ({
              type: "TextBlock",
              wrap: true,
              text: `${index + 1}. [${item.keyword_label}] ${item.title}\n${item.url}`,
            })),
          ],
        },
      },
    ],
  };

  const adaptive = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(adaptivePayload),
  });

  if (adaptive.ok) {
    return { ok: true };
  }

  const errorText = await adaptive.text();
  return {
    ok: false,
    error: `Teams webhook failed (${adaptive.status}): ${errorText.slice(0, 240)}`,
  };
}

async function sendSlackWebhook(webhookUrl, batch) {
  const headerText = `뉴스 알림 ${batch.length}건`;
  const sectionText = batch
    .slice(0, 20)
    .map((item, idx) => {
      const stamp = item.published_at ? ` (${new Date(item.published_at).toLocaleString("ko-KR")})` : "";
      return `${idx + 1}. *[${item.keyword_label}]* ${item.title}${stamp}\n${item.url}`;
    })
    .join("\n\n");

  const payload = {
    text: headerText,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: headerText },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: sectionText || "새로운 항목 없음" },
      },
    ],
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (res.ok) {
    return { ok: true };
  }

  const errorText = await res.text();
  return {
    ok: false,
    error: `Slack webhook failed (${res.status}): ${errorText.slice(0, 240)}`,
  };
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function getAppMode(env) {
  return env.APP_MODE === "single_user_slack" ? "single_user_slack" : "multi_user_teams";
}

function getMaxUsers(env) {
  const n = Number(env.MAX_USERS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_USERS;
}

function getMaxKeywordsPerUser(env) {
  const n = Number(env.MAX_KEYWORDS_PER_USER);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_KEYWORDS_PER_USER;
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidWebhook(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function getSessionSecret(env) {
  const secret = String(env.SESSION_SECRET || "").trim();
  if (!secret) {
    throw new Error("SESSION_SECRET is required");
  }
  return secret;
}

function buildCookie(name, value, maxAge, secure) {
  const secureAttr = secure ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureAttr}`;
}

async function signSessionToken(payload, secret) {
  const payloadBase64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacSha256Base64Url(secret, payloadBase64);
  return `${payloadBase64}.${signature}`;
}

async function verifySessionToken(token, secret) {
  const [payloadBase64, signature] = String(token || "").split(".");
  if (!payloadBase64 || !signature) return null;

  const expected = await hmacSha256Base64Url(secret, payloadBase64);
  if (!timingSafeEqual(expected, signature)) {
    return null;
  }

  try {
    const payloadBytes = fromBase64Url(payloadBase64);
    return JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 120000;
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations,
    },
    keyMaterial,
    256,
  );

  return `pbkdf2$${iterations}$${toBase64Url(salt)}$${toBase64Url(new Uint8Array(bits))}`;
}

async function verifyPassword(password, storedHash) {
  const [algo, itersRaw, saltRaw, hashRaw] = String(storedHash || "").split("$");
  if (algo !== "pbkdf2") return false;

  const iterations = Number(itersRaw);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;

  const salt = fromBase64Url(saltRaw);
  const expectedHash = hashRaw;

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations,
    },
    keyMaterial,
    256,
  );
  const computed = toBase64Url(new Uint8Array(bits));
  return timingSafeEqual(computed, expectedHash);
}

async function hmacSha256Base64Url(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return toBase64Url(new Uint8Array(sig));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  let base64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function timingSafeEqual(a, b) {
  const aa = String(a || "");
  const bb = String(b || "");
  if (aa.length !== bb.length) return false;

  let out = 0;
  for (let i = 0; i < aa.length; i += 1) {
    out |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  }
  return out === 0;
}
