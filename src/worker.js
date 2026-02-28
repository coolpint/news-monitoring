import { renderAppShell } from "./ui.js";

const COOKIE_NAME = "nm_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const DEFAULT_MAX_USERS = 30;
const DEFAULT_MAX_KEYWORDS_PER_USER = 40;
const ALL_TIER_VALUES = [1, 2, 3, 4];

const MEDIA_TIER_NAMES = {
  1: [
    "조선일보", "중앙일보", "동아일보", "한겨레", "경향신문", "매일경제", "한국경제", "한국일보", "연합뉴스", "KBS", "MBC",
  ],
  2: [
    "머니투데이", "헤럴드경제", "서울경제", "전자신문", "디지털타임스", "국민일보", "문화일보", "서울신문", "세계일보", "TV조선", "MBN",
  ],
  3: [
    "오마이뉴스", "머니S", "매일신문", "아이뉴스24", "프레시안", "더팩트", "비즈워치", "노컷뉴스", "블로터", "미디어오늘", "디지털데일리",
  ],
};
const MEDIA_TIER_DOMAINS = {
  1: ["chosun.com", "joongang.co.kr", "donga.com", "hani.co.kr", "khan.co.kr", "mk.co.kr", "hankyung.com", "hankookilbo.com", "yna.co.kr", "kbs.co.kr", "mbc.co.kr", "imbc.com"],
  2: ["mt.co.kr", "heraldcorp.com", "sedaily.com", "etnews.com", "dt.co.kr", "kmib.co.kr", "munhwa.com", "seoul.co.kr", "segye.com", "tvchosun.com", "mbn.co.kr"],
  3: ["ohmynews.com", "moneys.co.kr", "imaeil.com", "inews24.com", "pressian.com", "tf.co.kr", "bizwatch.co.kr", "nocutnews.co.kr", "bloter.net", "mediatoday.co.kr", "ddaily.co.kr"],
};
const MEDIA_TIER_LOOKUP = buildMediaTierLookup();

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      const path = safePath(request.url);
      const message = error && error.message ? error.message : String(error);
      console.error("Unhandled error", { path, message, error });
      if (path.startsWith("/api/")) {
        return jsonResponse({ error: "Internal Server Error", detail: String(message).slice(0, 600) }, 500);
      }
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
    await assertCoreSchema(env.DB);
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

  if (path === "/api/media-catalog" && method === "GET") {
    return listMediaCatalog(env);
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
  await assertCoreSchema(env.DB);
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
  await assertCoreSchema(env.DB);
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

  const keywords = (res.results || []).map((row) => {
    const config = parseKeywordConfig(row);
    return {
      ...row,
      query: config.compiledQuery,
      topic_label: config.topicLabel,
      keyword_path: buildKeywordPath(config.topicLabel, row.label),
      search_terms: config.searchTerms,
      must_include_terms: config.mustIncludeTerms,
      exclude_terms: config.excludeTerms,
      tier_filters: config.tierFilters,
      active: Number(row.active) === 1,
    };
  });

  return jsonResponse({ keywords });
}

async function createKeyword(request, env, user) {
  const body = await readJson(request);
  const label = String(body.label || "").trim();
  const topicLabel = collapseSpace(String(body.topicLabel || ""));
  const source = String(body.source || "google_rss").trim();
  const searchTerms = normalizeSearchTermsInput(body.searchTerms, body.query);
  const mustIncludeTerms = normalizeTermArray(body.mustIncludeTerms);
  const excludeTerms = normalizeTermArray(body.excludeTerms);
  const tierFilters = normalizeTierFilters(body.tierFilters);
  const query = buildExactOrQuery(searchTerms);

  if (!label || !searchTerms.length) {
    return jsonResponse({ error: "label and at least one search term are required" }, 400);
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
    .bind(
      id,
      userId,
      label,
      query,
      JSON.stringify({ topicLabel, searchTerms, mustIncludeTerms, excludeTerms, tierFilters }),
      source,
    )
    .run();

  return jsonResponse({ ok: true, id });
}

async function patchKeyword(request, env, user, keywordId) {
  const row = await env.DB.prepare("SELECT id, user_id, query, exclude_terms FROM keywords WHERE id = ? LIMIT 1")
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
    // Backward compatibility path: query text can still be sent from old clients.
    const parsedTerms = normalizeSearchTermsInput(undefined, body.query);
    if (!parsedTerms.length) {
      return jsonResponse({ error: "At least one search term is required" }, 400);
    }
    body.searchTerms = parsedTerms;
  }
  if (body.active !== undefined) {
    fields.push("active = ?");
    params.push(Number(body.active) ? 1 : 0);
  }

  if (
    body.searchTerms !== undefined ||
    body.mustIncludeTerms !== undefined ||
    body.excludeTerms !== undefined ||
    body.tierFilters !== undefined ||
    body.topicLabel !== undefined
  ) {
    const current = parseKeywordConfig(row);
    const nextTopicLabel = body.topicLabel !== undefined
      ? collapseSpace(String(body.topicLabel || ""))
      : current.topicLabel;
    const nextSearchTerms = body.searchTerms !== undefined
      ? normalizeSearchTermsInput(body.searchTerms, undefined)
      : current.searchTerms;
    const nextMustIncludeTerms = body.mustIncludeTerms !== undefined
      ? normalizeTermArray(body.mustIncludeTerms)
      : current.mustIncludeTerms;
    const nextExcludeTerms = body.excludeTerms !== undefined
      ? normalizeTermArray(body.excludeTerms)
      : current.excludeTerms;
    const nextTierFilters = body.tierFilters !== undefined
      ? normalizeTierFilters(body.tierFilters)
      : current.tierFilters;

    if (!nextSearchTerms.length) {
      return jsonResponse({ error: "At least one search term is required" }, 400);
    }

    fields.push("query = ?");
    params.push(buildExactOrQuery(nextSearchTerms));
    fields.push("exclude_terms = ?");
    params.push(JSON.stringify({
      topicLabel: nextTopicLabel,
      searchTerms: nextSearchTerms,
      mustIncludeTerms: nextMustIncludeTerms,
      excludeTerms: nextExcludeTerms,
      tierFilters: nextTierFilters,
    }));
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

async function listMediaCatalog(env) {
  await ensureArticlePublisherColumns(env.DB);

  const discoveredRes = await env.DB.prepare(
    `SELECT publisher_name, publisher_domain, COUNT(*) AS article_count
     FROM articles
     GROUP BY publisher_name, publisher_domain
     ORDER BY article_count DESC
     LIMIT 400`,
  ).all();

  const discovered = (discoveredRes.results || []).map((row) => {
    const publisherName = collapseSpace(String(row.publisher_name || ""));
    const publisherDomain = collapseSpace(String(row.publisher_domain || ""));
    const displayName = publisherName || publisherDomain || "(미분류)";
    const tier = resolvePublisherTier(publisherName, publisherDomain);
    return {
      name: displayName,
      publisher_name: publisherName,
      publisher_domain: publisherDomain,
      tier,
      article_count: Number(row.article_count || 0),
    };
  });

  const tiers = ALL_TIER_VALUES.map((tier) => {
    const predefined = (MEDIA_TIER_NAMES[tier] || []).slice().sort((a, b) => a.localeCompare(b, "ko"));
    const discoveredCount = discovered.filter((x) => x.tier === tier).length;
    return {
      tier,
      label: `티어 ${tier}`,
      predefined_sources: predefined,
      predefined_count: predefined.length,
      discovered_count: discoveredCount,
    };
  });

  return jsonResponse({
    tiers,
    discovered,
  });
}

async function runPoll(env, triggerType) {
  const db = env.DB;
  await ensureArticlePublisherColumns(db);
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
            `INSERT INTO articles (id, source, query, title, url, normalized_url, published_at, summary, publisher_name, publisher_domain)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            article.publisherName,
            article.publisherDomain,
          )
          .run();

        if (Number(insertArticle.meta?.changes || 0) > 0) {
          newArticleCount += 1;
        }

        for (const row of group.rows) {
          const keywordConfig = row.keyword_config || parseKeywordConfig(row);
          if (!matchesTierFilter(article, keywordConfig.tierFilters)) {
            continue;
          }
          if (!matchesAnySearchTerm(article, keywordConfig.searchTerms)) {
            continue;
          }
          if (!includesAllMustTerms(article, keywordConfig.mustIncludeTerms)) {
            continue;
          }
          if (isExcluded(article, keywordConfig.excludeTerms)) {
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
              k.label AS keyword_label, k.query, k.exclude_terms,
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

    const pendingWithPath = (pendingRows.results || []).map((row) => {
      const config = parseKeywordConfig({ query: row.query, exclude_terms: row.exclude_terms });
      return {
        ...row,
        keyword_path: buildKeywordPath(config.topicLabel, row.keyword_label),
      };
    });
    const groupedByChannel = groupByChannel(pendingWithPath);
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
    const config = parseKeywordConfig(row);
    const effectiveQuery = config.compiledQuery || row.query;
    const key = `${row.source}::${effectiveQuery}`;
    if (!map.has(key)) {
      map.set(key, { source: row.source, query: effectiveQuery, rows: [] });
    }
    map.get(key).rows.push({ ...row, query: effectiveQuery, keyword_config: config });
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
    const sourceName = collapseSpace(decodeEntities(stripCdata(getTagValue(raw, "source"))));
    const sourceUrl = decodeEntities(getTagAttribute(raw, "source", "url"));
    const sourceDomain = normalizeDomain(extractHost(sourceUrl) || extractHost(link));

    items.push({
      title: collapseSpace(title),
      url: link.trim(),
      normalizedUrl: normalizeUrl(link),
      summary: collapseSpace(description).slice(0, 500),
      publishedAt: toIsoDate(pubDateRaw),
      publisherName: sourceName,
      publisherDomain: sourceDomain,
    });
  }

  return items;
}

function getTagValue(text, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = text.match(regex);
  return match ? match[1] : "";
}

function getTagAttribute(text, tag, attribute) {
  const regex = new RegExp(`<${tag}\\b[^>]*\\b${attribute}="([^"]*)"[^>]*>`, "i");
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

function extractHost(input) {
  try {
    const url = new URL(String(input || "").trim());
    return url.hostname || "";
  } catch {
    return "";
  }
}

function normalizeDomain(value) {
  const host = String(value || "").trim().toLowerCase();
  if (!host) return "";
  return host.startsWith("www.") ? host.slice(4) : host;
}

function buildMediaTierLookup() {
  const nameMap = new Map();
  const domainMap = new Map();

  for (const tier of ALL_TIER_VALUES) {
    for (const name of MEDIA_TIER_NAMES[tier] || []) {
      const key = normalizePublisherKey(name);
      if (key) nameMap.set(key, tier);
    }
    for (const domain of MEDIA_TIER_DOMAINS[tier] || []) {
      const key = normalizeDomain(domain);
      if (key) domainMap.set(key, tier);
    }
  }

  return { nameMap, domainMap };
}

function normalizePublisherKey(value) {
  return String(value || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();
}

function resolvePublisherTier(publisherName, publisherDomain) {
  const nameKey = normalizePublisherKey(publisherName);
  if (nameKey && MEDIA_TIER_LOOKUP.nameMap.has(nameKey)) {
    return MEDIA_TIER_LOOKUP.nameMap.get(nameKey);
  }

  const domainKey = normalizeDomain(publisherDomain);
  if (domainKey) {
    if (MEDIA_TIER_LOOKUP.domainMap.has(domainKey)) {
      return MEDIA_TIER_LOOKUP.domainMap.get(domainKey);
    }
    for (const [knownDomain, tier] of MEDIA_TIER_LOOKUP.domainMap.entries()) {
      if (domainKey === knownDomain || domainKey.endsWith(`.${knownDomain}`)) {
        return tier;
      }
    }
  }

  return 4;
}

function matchesTierFilter(article, tierFilters) {
  const filters = normalizeTierFilters(tierFilters);
  if (!filters.length) return true;
  const domainFromUrl = normalizeDomain(extractHost(article?.normalizedUrl || article?.url));
  const tier = resolvePublisherTier(article?.publisherName, article?.publisherDomain || domainFromUrl);
  return filters.includes(tier);
}

function buildArticleHaystack(article) {
  return normalizeMatchText(`${article?.title || ""} ${article?.summary || ""}`);
}

function matchesAnySearchTerm(article, searchTerms) {
  const terms = normalizeTermArray(searchTerms);
  if (!terms.length) return true;
  const haystack = buildArticleHaystack(article);
  return terms.some((term) => containsExactTerm(haystack, term));
}

function includesAllMustTerms(article, mustIncludeTerms) {
  const terms = normalizeTermArray(mustIncludeTerms);
  if (!terms.length) return true;
  const haystack = buildArticleHaystack(article);
  return terms.every((term) => containsExactTerm(haystack, term));
}

function isExcluded(article, excludeTerms) {
  const terms = normalizeTermArray(excludeTerms);
  if (!terms.length) return false;
  const haystack = buildArticleHaystack(article);
  return terms.some((term) => containsExactTerm(haystack, term));
}

function containsExactTerm(normalizedHaystack, term) {
  const needle = normalizeMatchText(term);
  if (!needle) return false;
  return normalizedHaystack.includes(needle);
}

function normalizeMatchText(value) {
  return String(value || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
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
    const keywordLabel = item.keyword_path || item.keyword_label;
    return `${index + 1}. [${keywordLabel}] ${item.title}${stamp}\n${item.url}`;
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
              text: `${index + 1}. [${item.keyword_path || item.keyword_label}] ${item.title}\n${item.url}`,
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
      const keywordLabel = item.keyword_path || item.keyword_label;
      return `${idx + 1}. *[${keywordLabel}]* ${item.title}${stamp}\n${item.url}`;
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

function parseKeywordConfig(row) {
  const compiledQueryRaw = collapseSpace(String(row?.query || ""));
  const parsed = safeJson(row?.exclude_terms);

  if (Array.isArray(parsed)) {
    const searchTerms = normalizeSearchTermsInput(undefined, compiledQueryRaw);
    return {
      compiledQuery: compiledQueryRaw || buildExactOrQuery(searchTerms),
      topicLabel: "",
      searchTerms,
      mustIncludeTerms: [],
      excludeTerms: normalizeTermArray(parsed),
      tierFilters: [],
    };
  }

  if (parsed && typeof parsed === "object") {
    const topicLabel = collapseSpace(String(parsed.topicLabel || parsed.topic || ""));
    const searchTerms = normalizeSearchTermsInput(parsed.searchTerms, compiledQueryRaw);
    const resolvedSearchTerms = searchTerms.length
      ? searchTerms
      : normalizeSearchTermsInput(undefined, compiledQueryRaw);
    const mustIncludeTerms = normalizeTermArray(parsed.mustIncludeTerms);
    const excludeTerms = normalizeTermArray(parsed.excludeTerms);
    const tierFilters = normalizeTierFilters(parsed.tierFilters || parsed.tiers);
    return {
      compiledQuery: buildExactOrQuery(resolvedSearchTerms) || compiledQueryRaw,
      topicLabel,
      searchTerms: resolvedSearchTerms,
      mustIncludeTerms,
      excludeTerms,
      tierFilters,
    };
  }

  const fallbackSearchTerms = normalizeSearchTermsInput(undefined, compiledQueryRaw);
  return {
    compiledQuery: compiledQueryRaw || buildExactOrQuery(fallbackSearchTerms),
    topicLabel: "",
    searchTerms: fallbackSearchTerms,
    mustIncludeTerms: [],
    excludeTerms: [],
    tierFilters: [],
  };
}

function buildKeywordPath(topicLabel, keywordLabel) {
  const topic = collapseSpace(String(topicLabel || ""));
  const keyword = collapseSpace(String(keywordLabel || ""));
  if (topic && keyword) {
    return `${topic}>${keyword}`;
  }
  return topic || keyword;
}

function normalizeSearchTermsInput(searchTerms, queryFallback) {
  if (searchTerms !== undefined && searchTerms !== null) {
    if (Array.isArray(searchTerms)) {
      return normalizeTermArray(searchTerms);
    }

    const raw = String(searchTerms || "");
    const quoted = [...raw.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    if (quoted.length) {
      return normalizeTermArray(quoted);
    }

    if (/\s+OR\s+/i.test(raw) && !/[,\n]/.test(raw)) {
      return normalizeTermArray(raw.split(/\s+OR\s+/i));
    }

    return normalizeTermArray(raw);
  }

  const queryText = collapseSpace(String(queryFallback || ""));
  if (!queryText) return [];

  const quoted = [...queryText.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  if (quoted.length) {
    return normalizeTermArray(quoted);
  }

  return normalizeTermArray(queryText.split(/\s+OR\s+/i));
}

function normalizeTermArray(input) {
  let parts = [];
  if (Array.isArray(input)) {
    parts = input;
  } else if (input !== undefined && input !== null) {
    parts = String(input).split(/[\n,]+/);
  }

  const out = [];
  const seen = new Set();
  for (const value of parts) {
    const normalized = collapseSpace(String(value || "").replace(/"/g, ""));
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function normalizeTierFilters(input) {
  let parts = [];
  if (Array.isArray(input)) {
    parts = input;
  } else if (input !== undefined && input !== null && input !== "") {
    parts = String(input).split(/[\n,]+/);
  }

  const out = [];
  const seen = new Set();
  for (const raw of parts) {
    const n = Number(String(raw).replace(/[^\d]/g, ""));
    if (!Number.isInteger(n) || n < 1 || n > 4) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out.sort((a, b) => a - b);
}

function buildExactOrQuery(searchTerms) {
  const terms = normalizeTermArray(searchTerms);
  return terms.map((term) => `"${term}"`).join(" OR ");
}

function safeJson(value) {
  try {
    return JSON.parse(value || "null");
  } catch {
    return null;
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
  try {
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
  } catch {
    // Fallback for environments where PBKDF2 deriveBits is unavailable.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${toBase64Url(salt)}:${password}`),
    );
    return `sha256$${toBase64Url(salt)}$${toBase64Url(new Uint8Array(digest))}`;
  }
}

async function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split("$");
  const algo = parts[0];

  if (algo === "pbkdf2") {
    const itersRaw = parts[1];
    const saltRaw = parts[2];
    const hashRaw = parts[3];

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

  if (algo === "sha256") {
    const saltRaw = parts[1];
    const expectedHash = parts[2];
    if (!saltRaw || !expectedHash) return false;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${saltRaw}:${password}`),
    );
    const computed = toBase64Url(new Uint8Array(digest));
    return timingSafeEqual(computed, expectedHash);
  }

  return false;
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

function safePath(url) {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return "/";
  }
}

async function assertCoreSchema(db) {
  await assertTableColumns(db, "users", ["id", "email", "name", "password_hash", "role", "active"]);
}

async function ensureArticlePublisherColumns(db) {
  const table = await db.prepare("PRAGMA table_info(articles)").all();
  const rows = table.results || [];
  if (!rows.length) return;
  const existing = new Set(rows.map((row) => String(row.name)));

  const statements = [];
  if (!existing.has("publisher_name")) {
    statements.push("ALTER TABLE articles ADD COLUMN publisher_name TEXT");
  }
  if (!existing.has("publisher_domain")) {
    statements.push("ALTER TABLE articles ADD COLUMN publisher_domain TEXT");
  }

  for (const statement of statements) {
    try {
      await db.prepare(statement).run();
    } catch (error) {
      const message = String(error?.message || error);
      if (!/duplicate column name/i.test(message)) {
        throw error;
      }
    }
  }
}

async function assertTableColumns(db, table, requiredColumns) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all();
  const rows = result.results || [];
  if (!rows.length) {
    throw new Error(
      `Database table '${table}' is missing. Run: npx wrangler d1 execute news_monitoring --remote --file=./sql/schema.sql`,
    );
  }

  const existing = new Set(rows.map((row) => String(row.name)));
  const missing = requiredColumns.filter((name) => !existing.has(name));
  if (missing.length) {
    throw new Error(
      `Database schema mismatch for '${table}'. Missing: ${missing.join(", ")}. Re-run sql/schema.sql migration.`,
    );
  }
}
