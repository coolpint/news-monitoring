function clientMain() {
  const state = {
    bootstrap: null,
    me: null,
    keywords: [],
    channels: [],
    mediaCatalog: { tiers: [], discovered: [] },
    mediaSources: [],
    mediaSearch: "",
    users: [],
    runs: [],
    notice: null,
  };

  const app = document.getElementById("app");
  const modeLabel = document.getElementById("modeLabel");

  function esc(value) {
    const input = value === null || value === undefined ? "" : String(value);
    return input
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function parseTermInput(value) {
    return String(value || "")
      .split(/[\n,]+/)
      .map((term) => term.trim())
      .filter(Boolean);
  }

  function normalizeTierFilters(value) {
    const input = Array.isArray(value) ? value : [];
    const tiers = input
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v >= 1 && v <= 4)
      .sort((a, b) => a - b);
    const unique = [];
    for (const tier of tiers) {
      if (!unique.includes(tier)) unique.push(tier);
    }
    return unique;
  }

  function displayTierFilters(value) {
    const tiers = normalizeTierFilters(value);
    if (!tiers.length || tiers.length === 4) return "전체";
    return tiers.map((tier) => `T${tier}`).join(", ");
  }

  function collectKeywordTierFilters() {
    const selected = [];
    for (let tier = 1; tier <= 4; tier += 1) {
      const checkbox = document.getElementById(`kwTier${tier}`);
      if (checkbox && checkbox.checked) selected.push(tier);
    }
    if (!selected.length || selected.length === 4) return [];
    return selected;
  }

  function channelWebhookPlaceholder(type) {
    if (type === "telegram") {
      return "tg://<bot_token>/<chat_id>";
    }
    if (type === "slack") {
      return "https://hooks.slack.com/services/...";
    }
    return "https://...";
  }

  function channelWebhookHint(type) {
    if (type === "telegram") {
      return "Telegram은 tg://<bot_token>/<chat_id> 또는 api.telegram.org sendMessage URL(chat_id 포함)을 입력하세요.";
    }
    return "";
  }

  async function api(path, options = {}) {
    const init = { ...options };
    init.headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (options.body && typeof options.body !== "string") {
      init.body = JSON.stringify(options.body);
    }

    const res = await fetch(path, init);
    const contentType = res.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const data = isJson ? await res.json() : null;
    if (!res.ok) {
      throw new Error((data && data.error) || "Request failed (" + res.status + ")");
    }
    return data;
  }

  function setNotice(message, isError = false) {
    state.notice = { message, isError };
    render();
  }

  async function init() {
    const watchdog = setTimeout(() => {
      if (!state.bootstrap && !state.me) {
        setNotice("초기화가 지연되고 있습니다. URL + /api/bootstrap-status 응답을 확인해 주세요.", true);
      }
    }, 8000);

    try {
      state.bootstrap = await api("/api/bootstrap-status");
      modeLabel.textContent = state.bootstrap.appMode === "single_user_slack"
        ? "Single User Slack Mode"
        : "Multi User Teams Mode";
    } catch (err) {
      clearTimeout(watchdog);
      setNotice(err.message, true);
      return;
    }

    try {
      await refreshSession();
    } finally {
      clearTimeout(watchdog);
    }
  }

  async function refreshSession() {
    try {
      const me = await api("/api/me");
      state.me = me.user;
    } catch {
      state.me = null;
    }

    if (state.me) {
      await loadData();
    }
    render();
  }

  async function loadData() {
    const [keywords, channels, mediaCatalog, mediaSources] = await Promise.all([
      api("/api/keywords"),
      api("/api/channels"),
      api("/api/media-catalog"),
      api("/api/media-sources"),
    ]);
    state.keywords = keywords.keywords || [];
    state.channels = channels.channels || [];
    state.mediaCatalog = mediaCatalog || { tiers: [], discovered: [] };
    state.mediaSources = mediaSources.sources || [];

    if (state.me.role === "admin") {
      const [runs, users] = await Promise.all([api("/api/poll-runs"), api("/api/users")]);
      state.runs = runs.runs || [];
      state.users = users.users || [];
    } else {
      state.runs = [];
      state.users = [];
    }
  }

  function renderLogin() {
    if (!state.bootstrap || !state.bootstrap.hasUsers) {
      return `
        <section class="card">
          <h2>초기 관리자 계정 생성</h2>
          <div class="row inline">
            <div><label>이름</label><input id="adminName" placeholder="관리자" /></div>
            <div><label>이메일</label><input id="adminEmail" type="email" placeholder="admin@company.com" /></div>
          </div>
          <div class="row"><div><label>비밀번호</label><input id="adminPassword" type="password" placeholder="8자 이상" /></div></div>
          <div class="btns"><button id="createAdminBtn">생성</button></div>
        </section>
      `;
    }

    return `
      <section class="card">
        <h2>로그인</h2>
        <div class="row inline">
          <div><label>이메일</label><input id="loginEmail" type="email" /></div>
          <div><label>비밀번호</label><input id="loginPassword" type="password" /></div>
        </div>
        <div class="btns"><button id="loginBtn">로그인</button></div>
      </section>
    `;
  }

  function renderDashboard() {
    const isAdmin = state.me.role === "admin";
    const sortedKeywords = [...state.keywords].sort((a, b) => {
      const topicA = String(a.topic_label || "").toLowerCase();
      const topicB = String(b.topic_label || "").toLowerCase();
      if (topicA !== topicB) return topicA.localeCompare(topicB, "ko");
      return String(a.label || "").localeCompare(String(b.label || ""), "ko");
    });

    const keywordRows = sortedKeywords.map((k) => `
      <tr>
        <td>${esc(k.topic_label || "-")}</td>
        <td>${esc(k.label || "-")}</td>
        <td>${(k.search_terms || []).map((x) => `<span class="pill">${esc(x)}</span>`).join(" ") || "-"}</td>
        <td>${(k.must_include_terms || []).map((x) => `<span class="pill">${esc(x)}</span>`).join(" ") || "-"}</td>
        <td>${(k.exclude_terms || []).map((x) => `<span class="pill">${esc(x)}</span>`).join(" ") || "-"}</td>
        <td>${esc(displayTierFilters(k.tier_filters))}</td>
        <td>${k.active ? "ON" : "OFF"}</td>
        <td>
          <div class="btns">
            <button class="ghost" data-action="diagnose-keyword" data-id="${k.id}">진단</button>
            <button class="ghost" data-action="edit-keyword" data-id="${k.id}">수정</button>
            <button class="ghost" data-action="toggle-keyword" data-id="${k.id}" data-active="${k.active ? 1 : 0}">${k.active ? "중지" : "활성화"}</button>
            <button class="warn" data-action="delete-keyword" data-id="${k.id}">삭제</button>
          </div>
        </td>
      </tr>
    `).join("");

    const mediaSearch = state.mediaSearch.trim().toLowerCase();
    const filteredMediaSources = (state.mediaSources || [])
      .filter((item) => {
        if (!mediaSearch) return true;
        const haystack = `${item.name || ""} ${item.domain || ""} ${item.site_url || ""}`.toLowerCase();
        return haystack.includes(mediaSearch);
      })
      .sort((a, b) => {
        const tierDiff = Number(a.tier || 4) - Number(b.tier || 4);
        if (tierDiff !== 0) return tierDiff;
        return String(a.name || a.domain || "").localeCompare(String(b.name || b.domain || ""), "ko");
      });

    const tierBoardColumns = [1, 2, 3, 4].map((tier) => {
      const items = filteredMediaSources.filter((item) => Number(item.tier || 4) === tier);
      const cards = items.map((item) => `
        <div class="media-chip ${isAdmin ? "draggable" : ""}" ${isAdmin ? "draggable='true'" : ""} data-media-drag-id="${item.id}" data-current-tier="${tier}">
          <div class="media-chip-name">${esc(item.name || item.domain || "-")}</div>
          <div class="media-chip-sub">${esc(item.domain || "-")}</div>
        </div>
      `).join("");
      const dropAttr = isAdmin ? ` data-tier-dropzone="${tier}"` : "";
      return `
        <div class="tier-column t${tier}"${dropAttr}>
          <div class="tier-column-head">
            <span><span class="tier-dot t${tier}"></span>티어 ${tier}</span>
            <span class="muted">${items.length}</span>
          </div>
          <div class="tier-column-list">
            ${cards || "<div class='muted empty-drop'>비어 있음</div>"}
          </div>
        </div>
      `;
    }).join("");

    const discoveredRows = (state.mediaCatalog.discovered || [])
      .filter((item) => {
        if (!mediaSearch) return true;
        const haystack = `${item.name || ""} ${item.publisher_domain || ""}`.toLowerCase();
        return haystack.includes(mediaSearch);
      })
      .slice(0, 120)
      .map((item) => `
        <tr>
          <td>${esc(item.name || "-")}</td>
          <td>T${item.tier}</td>
          <td>${esc(item.publisher_domain || "-")}</td>
          <td>${item.article_count}</td>
        </tr>
      `).join("");

    const mediaSourceRows = (state.mediaSources || []).map((item) => {
      const tier = Number(item.tier || 4);
      const tierOptions = [1, 2, 3, 4]
        .map((value) => `<option value="${value}" ${tier === value ? "selected" : ""}>T${value}</option>`)
        .join("");
      return `
      <tr>
        <td>${isAdmin
          ? `<input class="media-edit" data-media-name-id="${item.id}" data-original-name="${esc(item.name || "")}" value="${esc(item.name || "")}" />`
          : esc(item.name || "-")}</td>
        <td>
          <div class="media-domain">${esc(item.domain || "-")}</div>
          ${isAdmin
            ? `<input class="media-edit" data-media-site-url-id="${item.id}" data-original-site-url="${esc(item.site_url || "")}" value="${esc(item.site_url || "")}" placeholder="https://example.com" />`
            : ""}
        </td>
        <td>${isAdmin
          ? `<select class="media-edit" data-media-tier-id="${item.id}" data-original-tier="${tier}">${tierOptions}</select>`
          : `T${tier}`}</td>
        <td>${item.rss_supported ? "RSS" : "-"}</td>
        <td>${item.naver_supported ? "Naver" : "-"}</td>
        <td>${esc(item.probe_status || "-")}</td>
        <td>${esc(item.probe_note || "-")}</td>
        <td>${item.active ? "ON" : "OFF"}</td>
        ${isAdmin ? `<td>
          <div class="btns">
            <button class="ghost" data-action="media-save" data-id="${item.id}">저장</button>
            <button class="ghost" data-action="media-reprobe" data-id="${item.id}">재검사</button>
            <button class="ghost" data-action="media-toggle" data-id="${item.id}" data-active="${item.active ? 1 : 0}">${item.active ? "중지" : "활성화"}</button>
            <button class="warn" data-action="media-delete" data-id="${item.id}">삭제</button>
          </div>
        </td>` : ""}
      </tr>
    `;
    }).join("");

    const channelRows = state.channels.map((c) => `
      <tr>
        <td>${esc(c.name)}</td>
        <td>${esc(c.type)}</td>
        <td>${esc((c.webhook_url || "").slice(0, 48))}...</td>
        <td>${c.active ? "ON" : "OFF"}</td>
        ${isAdmin ? `<td>
          <div class="btns">
            <button class="ghost" data-action="toggle-channel" data-id="${c.id}" data-active="${c.active ? 1 : 0}">${c.active ? "중지" : "활성화"}</button>
            <button class="warn" data-action="delete-channel" data-id="${c.id}">삭제</button>
          </div>
        </td>` : ""}
      </tr>
    `).join("");

    const runRows = state.runs.map((r) => `
      <tr>
        <td>${new Date(r.started_at).toLocaleString()}</td>
        <td>${esc(r.trigger_type)}</td>
        <td>${esc(r.status)}</td>
        <td>${r.fetched_count} / ${r.new_article_count}</td>
        <td>${r.sent_notifications} / ${r.failed_notifications}</td>
      </tr>
    `).join("");

    const userPanel = (isAdmin && state.bootstrap.appMode === "multi_user_teams") ? `
      <section class="card">
        <h2>사용자 관리</h2>
        <table>
          <thead><tr><th>이름</th><th>이메일</th><th>역할</th><th>활성</th></tr></thead>
          <tbody>
            ${state.users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${u.active ? "ON" : "OFF"}</td></tr>`).join("")}
          </tbody>
        </table>
        <div class="row inline" style="margin-top:10px;">
          <div><label>이름</label><input id="newUserName" /></div>
          <div><label>이메일</label><input id="newUserEmail" type="email" /></div>
          <div><label>초기 비밀번호</label><input id="newUserPassword" type="password" /></div>
        </div>
        <div class="btns"><button id="addUserBtn">사용자 추가</button></div>
      </section>
    ` : "";

    const runPanel = isAdmin ? `
      <section class="card">
        <h2>최근 실행</h2>
        <table>
          <thead><tr><th>시작</th><th>트리거</th><th>상태</th><th>수집/신규</th><th>성공/실패</th></tr></thead>
          <tbody>${runRows || "<tr><td colspan='5' class='muted'>실행 기록이 없습니다.</td></tr>"}</tbody>
        </table>
      </section>
    ` : "";

    return `
      <section class="card">
        <h2>운영</h2>
        <div class="muted">로그인 사용자: ${esc(state.me.name)} (${esc(state.me.email)})</div>
        <div class="btns" style="margin-top:10px;">
          ${isAdmin ? "<button id='runNowBtn'>지금 수집 실행</button>" : ""}
          <button id="refreshBtn" class="ghost">새로고침</button>
          <button id="logoutBtn" class="ghost">로그아웃</button>
        </div>
      </section>

      <section class="card">
        <h2>키워드 관리</h2>
        <div class="muted" style="margin-bottom:10px;">검색어는 정확 일치로 처리되며 여러 개 입력 시 OR 조건으로 동작합니다.</div>
        <table>
          <thead><tr><th>주제어</th><th>검색어</th><th>검색어(OR)</th><th>꼭 포함</th><th>제외</th><th>티어</th><th>상태</th><th>관리</th></tr></thead>
          <tbody>${keywordRows || "<tr><td colspan='8' class='muted'>아직 키워드가 없습니다.</td></tr>"}</tbody>
        </table>
        <div class="row inline" style="margin-top:10px;">
          <div><label>주제어 그룹</label><input id="kwTopic" placeholder="예: 지바이크" /></div>
          <div><label>검색어 이름</label><input id="kwLabel" placeholder="예: 경쟁사" /></div>
          <div><label>검색어(쉼표/줄바꿈)</label><input id="kwSearchTerms" placeholder="예: 회사명, 브랜드명" /></div>
          <div><label>꼭 포함(쉼표/줄바꿈)</label><input id="kwMustInclude" placeholder="예: 투자유치, 신제품" /></div>
          <div><label>제외어(쉼표/줄바꿈)</label><input id="kwExclude" placeholder="예: 채용, 공고" /></div>
        </div>
        <div class="tier-picks">
          <label><input id="kwTier1" type="checkbox" checked /> 티어1</label>
          <label><input id="kwTier2" type="checkbox" checked /> 티어2</label>
          <label><input id="kwTier3" type="checkbox" checked /> 티어3</label>
          <label><input id="kwTier4" type="checkbox" checked /> 티어4</label>
        </div>
        <div class="btns"><button id="addKeywordBtn">키워드 추가</button></div>
      </section>

      <section class="card">
        <div class="media-head">
          <h2 style="margin:0;">매체 티어</h2>
          <input id="mediaSearch" placeholder="매체명/도메인 검색" value="${esc(state.mediaSearch)}" />
        </div>
        ${isAdmin ? `<div class="row inline">
          <div><label>매체 URL</label><input id="mediaSiteUrl" placeholder="https://example.com" /></div>
          <div><label>표시 이름(선택)</label><input id="mediaName" placeholder="예: OO경제" /></div>
          <div><label>티어</label>
            <select id="mediaTier">
              <option value="1">티어1</option>
              <option value="2">티어2</option>
              <option value="3">티어3</option>
              <option value="4" selected>티어4</option>
            </select>
          </div>
        </div>
        <div class="btns" style="margin-bottom:12px;">
          <button id="addMediaSourceBtn">매체 추가 + RSS/네이버 검사</button>
        </div>` : `<div class="muted" style="margin-bottom:10px;">매체 추가/수정은 관리자만 가능합니다.</div>`}

        <table>
          <thead><tr><th>이름</th><th>도메인 / URL</th><th>티어</th><th>RSS</th><th>Naver</th><th>상태</th><th>결과</th><th>활성</th>${isAdmin ? "<th>관리</th>" : ""}</tr></thead>
          <tbody>${mediaSourceRows || `<tr><td colspan='${isAdmin ? "9" : "8"}' class='muted'>등록된 매체가 없습니다.</td></tr>`}</tbody>
        </table>

        <div class="muted" style="margin:12px 0 8px;">${isAdmin ? "티어 보드 (카드를 드래그해서 다른 티어 컬럼으로 이동)" : "티어 보드"}</div>
        <div class="tier-board">${tierBoardColumns || "<div class='muted'>티어 보드 데이터 없음</div>"}</div>
        <table style="margin-top:12px;">
          <thead><tr><th>매체</th><th>티어</th><th>도메인</th><th>수집건수</th></tr></thead>
          <tbody>${discoveredRows || "<tr><td colspan='4' class='muted'>수집된 매체 데이터가 아직 없습니다.</td></tr>"}</tbody>
        </table>
      </section>

      <section class="card">
        <h2>알림 채널</h2>
        ${isAdmin ? `<div class="row inline" style="margin-top:2px;">
          <div><label>채널 이름</label><input id="chName" placeholder="예: 홍보팀 Alerts" /></div>
          <div><label>타입</label>
            <select id="chType">
              ${state.bootstrap.appMode === "single_user_slack"
                ? "<option value='slack'>slack</option>"
                : "<option value='teams'>teams</option><option value='slack'>slack</option><option value='telegram'>telegram</option>"}
            </select>
          </div>
          <div><label>Webhook URL</label><input id="chWebhook" placeholder="https://..." /><div id="chWebhookHint" class="muted"></div></div>
        </div>
        <div class="btns" style="margin-bottom:10px;"><button id="addChannelBtn">채널 추가</button></div>` : `<div class="muted" style="margin-bottom:10px;">채널 관리는 관리자만 가능합니다. 알림은 전체 활성 채널로 공통 발송됩니다.</div>`}
        <table>
          <thead><tr><th>이름</th><th>타입</th><th>Webhook</th><th>상태</th>${isAdmin ? "<th>관리</th>" : ""}</tr></thead>
          <tbody>${channelRows || `<tr><td colspan='${isAdmin ? "5" : "4"}' class='muted'>채널이 없습니다.</td></tr>`}</tbody>
        </table>
      </section>

      ${userPanel}
      ${runPanel}
    `;
  }

  function render() {
    try {
      const notice = state.notice
        ? `<div class="msg ${state.notice.isError ? "error" : ""}">${esc(state.notice.message)}</div>`
        : "";

      app.innerHTML = notice + (state.me ? renderDashboard() : renderLogin());
      bindEvents();
    } catch (err) {
      const message = esc(err && err.message ? err.message : String(err));
      app.innerHTML = `<section class=\"card\"><h2>UI 초기화 오류</h2><div class=\"msg error\">${message}</div></section>`;
    }
  }

  function bindEvents() {
    const chType = document.getElementById("chType");
    const chWebhook = document.getElementById("chWebhook");
    const chWebhookHint = document.getElementById("chWebhookHint");
    if (chType && chWebhook) {
      const applyChannelInputs = () => {
        const type = String(chType.value || "teams");
        chWebhook.placeholder = channelWebhookPlaceholder(type);
        if (chWebhookHint) {
          chWebhookHint.textContent = channelWebhookHint(type);
        }
      };
      chType.addEventListener("change", applyChannelInputs);
      applyChannelInputs();
    }

    const loginBtn = document.getElementById("loginBtn");
    if (loginBtn) {
      loginBtn.addEventListener("click", async () => {
        try {
          await api("/api/login", {
            method: "POST",
            body: {
              email: document.getElementById("loginEmail").value,
              password: document.getElementById("loginPassword").value,
            },
          });
          state.notice = null;
          await refreshSession();
        } catch (err) {
          setNotice(err.message, true);
        }
      });
    }

    const createAdminBtn = document.getElementById("createAdminBtn");
    if (createAdminBtn) {
      createAdminBtn.addEventListener("click", async () => {
        try {
          await api("/api/bootstrap-admin", {
            method: "POST",
            body: {
              name: document.getElementById("adminName").value,
              email: document.getElementById("adminEmail").value,
              password: document.getElementById("adminPassword").value,
            },
          });
          state.notice = null;
          await init();
        } catch (err) {
          setNotice(err.message, true);
        }
      });
    }

    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async () => {
        await api("/api/logout", { method: "POST" });
        state.me = null;
        state.notice = null;
        render();
      });
    }

    const refreshBtn = document.getElementById("refreshBtn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", async () => {
        try {
          await loadData();
          state.notice = null;
          render();
        } catch (err) {
          setNotice(err.message, true);
        }
      });
    }

    const mediaSearchInput = document.getElementById("mediaSearch");
    if (mediaSearchInput) {
      mediaSearchInput.addEventListener("input", () => {
        state.mediaSearch = mediaSearchInput.value;
        render();
      });
    }

    if (state.me && state.me.role === "admin") {
      let draggingMediaId = "";
      app.querySelectorAll("[data-media-drag-id]").forEach((el) => {
        el.addEventListener("dragstart", (event) => {
          draggingMediaId = String(el.dataset.mediaDragId || "");
          el.classList.add("dragging");
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", draggingMediaId);
          }
        });
        el.addEventListener("dragend", () => {
          el.classList.remove("dragging");
          draggingMediaId = "";
          app.querySelectorAll("[data-tier-dropzone].over").forEach((zone) => zone.classList.remove("over"));
        });
      });

      app.querySelectorAll("[data-tier-dropzone]").forEach((zone) => {
        zone.addEventListener("dragover", (event) => {
          event.preventDefault();
          zone.classList.add("over");
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "move";
          }
        });
        zone.addEventListener("dragleave", () => {
          zone.classList.remove("over");
        });
        zone.addEventListener("drop", async (event) => {
          event.preventDefault();
          zone.classList.remove("over");
          const dropTier = Number(zone.dataset.tierDropzone || 0);
          const droppedId = (event.dataTransfer && event.dataTransfer.getData("text/plain")) || draggingMediaId;
          if (!dropTier || !droppedId) return;

          const current = (state.mediaSources || []).find((x) => x.id === droppedId);
          if (!current) return;
          if (Number(current.tier || 4) === dropTier) return;

          try {
            await api("/api/media-sources/" + droppedId, {
              method: "PATCH",
              body: { tier: dropTier },
            });
            setNotice(`티어 이동 완료: ${current.name || current.domain} → T${dropTier}`);
            await loadData();
            render();
          } catch (err) {
            setNotice(err.message, true);
          }
        });
      });
    }

    const runNowBtn = document.getElementById("runNowBtn");
    if (runNowBtn) {
      runNowBtn.addEventListener("click", async () => {
        try {
          const res = await api("/api/run-now", { method: "POST" });
          setNotice(`실행 완료: 신규 ${res.result.newArticleCount}건, 발송 ${res.result.sentNotifications}건`);
          await loadData();
          render();
        } catch (err) {
          setNotice(err.message, true);
        }
      });
    }

    const addKeywordBtn = document.getElementById("addKeywordBtn");
    if (addKeywordBtn) {
      addKeywordBtn.addEventListener("click", async () => {
        try {
          await api("/api/keywords", {
            method: "POST",
            body: {
              topicLabel: document.getElementById("kwTopic").value,
              label: document.getElementById("kwLabel").value,
              searchTerms: parseTermInput(document.getElementById("kwSearchTerms").value),
              mustIncludeTerms: parseTermInput(document.getElementById("kwMustInclude").value),
              excludeTerms: parseTermInput(document.getElementById("kwExclude").value),
              tierFilters: collectKeywordTierFilters(),
            },
          });
          setNotice("키워드를 추가했습니다.");
          await loadData();
          render();
        } catch (err) {
          setNotice(err.message, true);
        }
      });
    }

    const addMediaSourceBtn = document.getElementById("addMediaSourceBtn");
    if (addMediaSourceBtn) {
      addMediaSourceBtn.addEventListener("click", async () => {
        try {
          const res = await api("/api/media-sources", {
            method: "POST",
            body: {
              siteUrl: document.getElementById("mediaSiteUrl").value,
              name: document.getElementById("mediaName").value,
              tier: Number(document.getElementById("mediaTier").value || 4),
            },
          });
          setNotice(`매체 등록/검사 완료: ${res.source.name} (${res.source.probe_status})`);
          await loadData();
          render();
        } catch (err) {
          setNotice(err.message, true);
        }
      });
    }

    const addChannelBtn = document.getElementById("addChannelBtn");
    if (addChannelBtn) {
      addChannelBtn.addEventListener("click", async () => {
        try {
          await api("/api/channels", {
            method: "POST",
            body: {
              name: document.getElementById("chName").value,
              type: document.getElementById("chType").value,
              webhookUrl: document.getElementById("chWebhook").value,
            },
          });
          setNotice("채널을 추가했습니다.");
          await loadData();
          render();
        } catch (err) {
          setNotice(err.message, true);
        }
      });
    }

    const addUserBtn = document.getElementById("addUserBtn");
    if (addUserBtn) {
      addUserBtn.addEventListener("click", async () => {
        try {
          await api("/api/users", {
            method: "POST",
            body: {
              name: document.getElementById("newUserName").value,
              email: document.getElementById("newUserEmail").value,
              password: document.getElementById("newUserPassword").value,
            },
          });
          setNotice("사용자를 추가했습니다.");
          await loadData();
          render();
        } catch (err) {
          setNotice(err.message, true);
        }
      });
    }

    app.querySelectorAll("button[data-action='delete-keyword']").forEach((el) => {
      el.addEventListener("click", async () => {
        try {
          await api("/api/keywords/" + el.dataset.id, { method: "DELETE" });
          setNotice("키워드를 삭제했습니다.");
          await loadData();
          render();
        } catch (err) {
          setNotice(err.message, true);
        }
      });
    });

    app.querySelectorAll("button[data-action='toggle-keyword']").forEach((el) => {
      el.addEventListener("click", async () => {
        try {
          await api("/api/keywords/" + el.dataset.id, {
            method: "PATCH",
            body: { active: Number(el.dataset.active) === 1 ? 0 : 1 },
          });
          await loadData();
          render();
        } catch (err) {
          setNotice(err.message, true);
        }
      });
    });

    app.querySelectorAll("button[data-action='diagnose-keyword']").forEach((el) => {
      el.addEventListener("click", async () => {
        try {
          const res = await api("/api/keywords/" + el.dataset.id + "/diagnose");
          const m = res.metrics || {};
          setNotice(
            `진단 결과 - Google:${m.fetched_google_rss || 0}, CustomRSS:${m.fetched_custom_rss || 0}, 최종통과:${m.final_passed || 0}, 활성채널:${m.channels_active || 0}, 신규알림가능:${m.potential_new_notifications || 0}`,
            false,
          );
          console.log("keyword diagnose", res);
        } catch (err) {
          setNotice(err.message, true);
        }
      });
    });

    app.querySelectorAll("button[data-action='edit-keyword']").forEach((el) => {
      el.addEventListener("click", async () => {
        const current = state.keywords.find((x) => x.id === el.dataset.id);
        if (!current) return;

        const nextTopic = window.prompt("주제어 그룹", current.topic_label || "");
        if (nextTopic === null) return;
        const nextLabel = window.prompt("검색어 이름", current.label || "");
        if (nextLabel === null) return;
        const nextSearch = window.prompt("검색어(쉼표 구분, OR)", (current.search_terms || []).join(", "));
        if (nextSearch === null) return;
        const nextMust = window.prompt("꼭 포함(쉼표 구분)", (current.must_include_terms || []).join(", "));
        if (nextMust === null) return;
        const nextExclude = window.prompt("제외어(쉼표 구분)", (current.exclude_terms || []).join(", "));
        if (nextExclude === null) return;
        const defaultTierValue = normalizeTierFilters(current.tier_filters).length
          ? normalizeTierFilters(current.tier_filters).join(",")
          : "1,2,3,4";
        const nextTier = window.prompt("티어(예: 1,2,3 / 전체는 1,2,3,4)", defaultTierValue);
        if (nextTier === null) return;

        const parsedTier = normalizeTierFilters(String(nextTier).split(/[\s,]+/));
        const tierFilters = parsedTier.length === 4 ? [] : parsedTier;

        try {
          await api("/api/keywords/" + el.dataset.id, {
            method: "PATCH",
            body: {
              topicLabel: nextTopic,
              label: nextLabel,
              searchTerms: parseTermInput(nextSearch),
              mustIncludeTerms: parseTermInput(nextMust),
              excludeTerms: parseTermInput(nextExclude),
              tierFilters,
            },
          });
          setNotice("키워드를 수정했습니다.");
          await loadData();
          render();
        } catch (err) {
          setNotice(err.message, true);
        }
      });
    });

    app.querySelectorAll("button[data-action='media-reprobe']").forEach((el) => {
      el.addEventListener("click", async () => {
        try {
          await api("/api/media-sources/" + el.dataset.id, {
            method: "PATCH",
            body: { reprobe: 1 },
          });
          setNotice("매체 재검사를 완료했습니다.");
          await loadData();
          render();
        } catch (err) {
          setNotice(err.message, true);
        }
      });
    });

    app.querySelectorAll("button[data-action='media-save']").forEach((el) => {
      el.addEventListener("click", async () => {
        const id = String(el.dataset.id || "");
        const nameEl = app.querySelector(`input[data-media-name-id="${id}"]`);
        const siteUrlEl = app.querySelector(`input[data-media-site-url-id="${id}"]`);
        const tierEl = app.querySelector(`select[data-media-tier-id="${id}"]`);
        const name = nameEl ? nameEl.value.trim() : "";
        const siteUrl = siteUrlEl ? siteUrlEl.value.trim() : "";
        const tier = Number(tierEl ? tierEl.value : 4);
        const originalName = nameEl ? String(nameEl.dataset.originalName || "").trim() : "";
        const originalSiteUrl = siteUrlEl ? String(siteUrlEl.dataset.originalSiteUrl || "").trim() : "";
        const originalTier = Number(tierEl ? tierEl.dataset.originalTier : 4);
        const patch = {};

        if (name && name !== originalName) patch.name = name;
        if (siteUrl && siteUrl !== originalSiteUrl) patch.siteUrl = siteUrl;
        if (tier !== originalTier) patch.tier = tier;

        if (!Object.keys(patch).length) {
          setNotice("변경된 값이 없습니다.");
          return;
        }

        try {
          await api("/api/media-sources/" + id, {
            method: "PATCH",
            body: patch,
          });
          setNotice("매체 정보를 저장했습니다.");
          await loadData();
          render();
        } catch (err) {
          setNotice(err.message, true);
        }
      });
    });

    app.querySelectorAll("button[data-action='media-toggle']").forEach((el) => {
      el.addEventListener("click", async () => {
        try {
          await api("/api/media-sources/" + el.dataset.id, {
            method: "PATCH",
            body: { active: Number(el.dataset.active) === 1 ? 0 : 1 },
          });
          setNotice("매체 활성 상태를 변경했습니다.");
          await loadData();
          render();
        } catch (err) {
          setNotice(err.message, true);
        }
      });
    });

    app.querySelectorAll("button[data-action='media-delete']").forEach((el) => {
      el.addEventListener("click", async () => {
        try {
          await api("/api/media-sources/" + el.dataset.id, { method: "DELETE" });
          setNotice("매체를 삭제했습니다.");
          await loadData();
          render();
        } catch (err) {
          setNotice(err.message, true);
        }
      });
    });

    app.querySelectorAll("button[data-action='delete-channel']").forEach((el) => {
      el.addEventListener("click", async () => {
        try {
          await api("/api/channels/" + el.dataset.id, { method: "DELETE" });
          setNotice("채널을 삭제했습니다.");
          await loadData();
          render();
        } catch (err) {
          setNotice(err.message, true);
        }
      });
    });

    app.querySelectorAll("button[data-action='toggle-channel']").forEach((el) => {
      el.addEventListener("click", async () => {
        try {
          await api("/api/channels/" + el.dataset.id, {
            method: "PATCH",
            body: { active: Number(el.dataset.active) === 1 ? 0 : 1 },
          });
          await loadData();
          render();
        } catch (err) {
          setNotice(err.message, true);
        }
      });
    });
  }

  window.addEventListener("error", (event) => {
    const errObj = event && event.error ? event.error : null;
    const errMsg = errObj && errObj.message ? errObj.message : (event && event.message ? event.message : "unknown");
    setNotice("클라이언트 오류: " + errMsg, true);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason || "unknown");
    setNotice("비동기 오류: " + reason, true);
  });

  init().catch((err) => setNotice(err.message, true));
}

export function renderAppShell() {
  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>News Monitoring</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=Noto+Sans+KR:wght@400;500;700&display=swap" rel="stylesheet" />
    <style>
      :root {
        --bg: #f3f7f5;
        --panel: #ffffff;
        --ink: #15211d;
        --sub: #5c6d66;
        --line: #d7e2dd;
        --brand: #0b8f6b;
        --brand-2: #1cbaa0;
        --warn: #b6452c;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Noto Sans KR", "Apple SD Gothic Neo", sans-serif;
        color: var(--ink);
        background: radial-gradient(90rem 60rem at -15% -15%, #dbefe8 0%, transparent 55%),
          radial-gradient(80rem 50rem at 110% -10%, #d5ecf5 0%, transparent 55%),
          var(--bg);
      }
      .wrap {
        max-width: 1520px;
        margin: 0 auto;
        padding: 24px 16px 48px;
      }
      .head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin-bottom: 16px;
      }
      .title {
        margin: 0;
        font-family: "Space Grotesk", sans-serif;
        font-size: clamp(1.4rem, 4vw, 2rem);
        letter-spacing: -0.02em;
      }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: #fff;
        padding: 8px 12px;
        color: var(--sub);
        font-size: 0.85rem;
      }
      .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--brand);
      }
      .card {
        border: 1px solid var(--line);
        border-radius: 16px;
        background: var(--panel);
        padding: 16px;
        box-shadow: 0 8px 24px rgba(23, 42, 32, 0.06);
        margin-bottom: 14px;
      }
      .card h2 {
        margin: 0 0 12px;
        font-size: 1rem;
        font-family: "Space Grotesk", sans-serif;
      }
      .row {
        display: grid;
        gap: 8px;
        margin-bottom: 10px;
      }
      .row.inline {
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      }
      label {
        font-size: 0.83rem;
        color: var(--sub);
      }
      input, select {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: #fff;
        color: var(--ink);
      }
      button {
        border: 0;
        border-radius: 10px;
        padding: 10px 14px;
        background: linear-gradient(120deg, var(--brand), var(--brand-2));
        color: #fff;
        font-weight: 600;
        cursor: pointer;
      }
      button.ghost {
        background: #eff4f2;
        color: var(--ink);
      }
      button.warn {
        background: var(--warn);
      }
      .btns {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        border-bottom: 1px solid var(--line);
        text-align: left;
        padding: 9px 6px;
        font-size: 0.9rem;
        vertical-align: top;
      }
      th { color: var(--sub); font-size: 0.8rem; font-weight: 600; }
      .muted { color: var(--sub); font-size: 0.85rem; }
      .msg {
        margin-bottom: 12px;
        border: 1px solid #cde3db;
        background: #edf8f4;
        border-radius: 10px;
        padding: 10px 12px;
        font-size: 0.9rem;
      }
      .msg.error {
        border-color: #e6c5bc;
        background: #fbedeb;
      }
      .split {
        display: grid;
        gap: 14px;
        grid-template-columns: repeat(auto-fit, minmax(330px, 1fr));
      }
      .tier-picks {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 14px;
        margin: 8px 0 12px;
      }
      .tier-picks label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 6px 10px;
        font-size: 0.82rem;
        color: var(--ink);
        background: #fff;
      }
      .tier-picks input {
        width: auto;
        margin: 0;
        accent-color: var(--brand);
      }
      .media-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        margin-bottom: 12px;
      }
      .media-head input {
        max-width: 320px;
      }
      .media-edit {
        padding: 6px 8px;
        border-radius: 8px;
        font-size: 0.82rem;
        min-width: 120px;
      }
      .media-domain {
        font-size: 0.82rem;
        color: var(--ink);
        margin-bottom: 4px;
      }
      .tier-board {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
      }
      .tier-column {
        border: 1px solid var(--line);
        border-radius: 12px;
        background: #fbfefd;
        min-height: 260px;
        display: flex;
        flex-direction: column;
      }
      .tier-column-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        padding: 10px;
        border-bottom: 1px dashed var(--line);
      }
      .tier-column-head span:first-child {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 0.84rem;
        font-weight: 700;
      }
      .tier-column-list {
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-height: 200px;
      }
      .tier-column.over {
        border-color: var(--brand);
        box-shadow: inset 0 0 0 2px rgba(11, 143, 107, 0.18);
      }
      .media-chip {
        border: 1px solid var(--line);
        border-radius: 10px;
        background: #fff;
        padding: 8px;
      }
      .media-chip.draggable {
        cursor: grab;
      }
      .media-chip.dragging {
        opacity: 0.4;
      }
      .media-chip-name {
        font-size: 0.83rem;
        font-weight: 600;
        line-height: 1.3;
      }
      .media-chip-sub {
        font-size: 0.73rem;
        color: var(--sub);
        margin-top: 2px;
        word-break: break-all;
      }
      .empty-drop {
        padding: 8px 4px;
      }
      .tier-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 10px;
      }
      .tier-card {
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 10px;
        background: #fbfefd;
      }
      .tier-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      .tier-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
      }
      .tier-dot.t1 { background: #e85b68; }
      .tier-dot.t2 { background: #d1a43a; }
      .tier-dot.t3 { background: #46a8bb; }
      .tier-dot.t4 { background: #9aa6ac; }
      .tier-list {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .pill {
        display: inline-flex;
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 2px 8px;
        font-size: 0.78rem;
      }
      .footer {
        margin-top: 14px;
        color: var(--sub);
        font-size: 0.82rem;
      }
      @media (max-width: 720px) {
        .wrap { padding: 16px 10px 38px; }
        .card { padding: 12px; border-radius: 12px; }
        .media-head {
          flex-direction: column;
          align-items: stretch;
        }
        .media-head input {
          max-width: none;
        }
        .tier-board {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 1180px) and (min-width: 721px) {
        .tier-board {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <header class="head">
        <h1 class="title">News Monitoring Console</h1>
        <div class="status"><span class="dot"></span><span id="modeLabel">loading...</span></div>
      </header>
      <main id="app"></main>
      <div class="footer">5분 크론 기준으로 새 기사 감지 후 Teams/Slack/Telegram 채널로 전송됩니다.</div>
    </div>
    <script>
      // Wrangler/esbuild may inject helper wrappers like __name into function source.
      // Define a no-op helper so inline toString() code runs in browsers consistently.
      const __name = (target) => target;
      (${clientMain.toString()})();
    </script>
  </body>
</html>`;
}
