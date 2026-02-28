function clientMain() {
  const state = {
    bootstrap: null,
    me: null,
    keywords: [],
    channels: [],
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
    const loaders = [api("/api/keywords"), api("/api/channels"), api("/api/poll-runs")];
    if (state.me.role === "admin") {
      loaders.push(api("/api/users"));
    }
    const [keywords, channels, runs, users] = await Promise.all(loaders);
    state.keywords = keywords.keywords || [];
    state.channels = channels.channels || [];
    state.runs = runs.runs || [];
    state.users = (users && users.users) || [];
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
    const keywordRows = state.keywords.map((k) => `
      <tr>
        <td>${esc(k.keyword_path || ((k.topic_label ? `${k.topic_label}>` : "") + (k.label || "")))}</td>
        <td>${(k.search_terms || []).map((x) => `<span class="pill">${esc(x)}</span>`).join(" ") || "-"}</td>
        <td>${(k.must_include_terms || []).map((x) => `<span class="pill">${esc(x)}</span>`).join(" ") || "-"}</td>
        <td>${(k.exclude_terms || []).map((x) => `<span class="pill">${esc(x)}</span>`).join(" ") || "-"}</td>
        <td>${k.active ? "ON" : "OFF"}</td>
        <td>
          <div class="btns">
            <button class="ghost" data-action="set-topic" data-id="${k.id}" data-topic="${esc(k.topic_label || "")}">주제어 변경</button>
            <button class="ghost" data-action="toggle-keyword" data-id="${k.id}" data-active="${k.active ? 1 : 0}">${k.active ? "중지" : "활성화"}</button>
            <button class="warn" data-action="delete-keyword" data-id="${k.id}">삭제</button>
          </div>
        </td>
      </tr>
    `).join("");

    const channelRows = state.channels.map((c) => `
      <tr>
        <td>${esc(c.name)}</td>
        <td>${esc(c.type)}</td>
        <td>${esc((c.webhook_url || "").slice(0, 48))}...</td>
        <td>${c.active ? "ON" : "OFF"}</td>
        <td>
          <div class="btns">
            <button class="ghost" data-action="toggle-channel" data-id="${c.id}" data-active="${c.active ? 1 : 0}">${c.active ? "중지" : "활성화"}</button>
            <button class="warn" data-action="delete-channel" data-id="${c.id}">삭제</button>
          </div>
        </td>
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

    const userPanel = (state.me.role === "admin" && state.bootstrap.appMode === "multi_user_teams") ? `
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

    return `
      <section class="card">
        <h2>운영</h2>
        <div class="muted">로그인 사용자: ${esc(state.me.name)} (${esc(state.me.email)})</div>
        <div class="btns" style="margin-top:10px;">
          <button id="runNowBtn">지금 수집 실행</button>
          <button id="refreshBtn" class="ghost">새로고침</button>
          <button id="logoutBtn" class="ghost">로그아웃</button>
        </div>
      </section>

      <div class="split">
        <section class="card">
          <h2>키워드</h2>
          <div class="muted" style="margin-bottom:10px;">검색어는 정확 일치로 처리되며 여러 개 입력 시 OR 조건으로 동작합니다.</div>
          <div class="muted" style="margin-bottom:10px;">주제어를 입력하면 알림 라벨이 주제어&gt;검색어 형태로 표시됩니다.</div>
          <table>
            <thead><tr><th>주제어&gt;검색어</th><th>검색어(OR)</th><th>꼭 포함</th><th>제외</th><th>상태</th><th>관리</th></tr></thead>
            <tbody>${keywordRows || "<tr><td colspan='6' class='muted'>아직 키워드가 없습니다.</td></tr>"}</tbody>
          </table>
          <div class="row inline" style="margin-top:10px;">
            <div><label>주제어 그룹</label><input id="kwTopic" placeholder="예: 지바이크" /></div>
            <div><label>검색어 이름</label><input id="kwLabel" placeholder="예: 경쟁사" /></div>
            <div><label>검색어(쉼표/줄바꿈)</label><input id="kwSearchTerms" placeholder="예: 회사명, 브랜드명" /></div>
            <div><label>꼭 포함(쉼표/줄바꿈)</label><input id="kwMustInclude" placeholder="예: 투자유치, 신제품" /></div>
            <div><label>제외어(쉼표/줄바꿈)</label><input id="kwExclude" placeholder="예: 채용, 공고" /></div>
          </div>
          <div class="btns"><button id="addKeywordBtn">키워드 추가</button></div>
        </section>

        <section class="card">
          <h2>알림 채널</h2>
          <table>
            <thead><tr><th>이름</th><th>타입</th><th>Webhook</th><th>상태</th><th>관리</th></tr></thead>
            <tbody>${channelRows || "<tr><td colspan='5' class='muted'>채널이 없습니다.</td></tr>"}</tbody>
          </table>
          <div class="row inline" style="margin-top:10px;">
            <div><label>채널 이름</label><input id="chName" placeholder="예: 홍보팀 Alerts" /></div>
            <div><label>타입</label>
              <select id="chType">
                ${state.bootstrap.appMode === "single_user_slack"
                  ? "<option value='slack'>slack</option>"
                  : "<option value='teams'>teams</option><option value='slack'>slack</option>"}
              </select>
            </div>
            <div><label>Webhook URL</label><input id="chWebhook" placeholder="https://..." /></div>
          </div>
          <div class="btns"><button id="addChannelBtn">채널 추가</button></div>
        </section>
      </div>

      ${userPanel}

      <section class="card">
        <h2>최근 실행</h2>
        <table>
          <thead><tr><th>시작</th><th>트리거</th><th>상태</th><th>수집/신규</th><th>성공/실패</th></tr></thead>
          <tbody>${runRows || "<tr><td colspan='5' class='muted'>실행 기록이 없습니다.</td></tr>"}</tbody>
        </table>
      </section>
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

    app.querySelectorAll("button[data-action='set-topic']").forEach((el) => {
      el.addEventListener("click", async () => {
        const nextTopic = window.prompt("주제어 그룹을 입력하세요. 비워두면 해제됩니다.", el.dataset.topic || "");
        if (nextTopic === null) return;

        try {
          await api("/api/keywords/" + el.dataset.id, {
            method: "PATCH",
            body: { topicLabel: nextTopic },
          });
          setNotice("주제어 그룹을 변경했습니다.");
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
        max-width: 1120px;
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
        th:nth-child(4), td:nth-child(4) { display: none; }
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
      <div class="footer">5분 크론 기준으로 새 기사 감지 후 Teams/Slack 웹훅으로 전송됩니다.</div>
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
