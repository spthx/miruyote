const API_URL = "https://graphql.anilist.co";
const STORAGE_KEY = "miruyote-state-v1";
const CACHE_KEY = "miruyote-anilist-cache-v1";
const channels = ["TOKYO MX", "テレビ愛知", "MBS", "ABCテレビ", "BS11", "BS日テレ", "AT-X", "その他"];
const services = ["dアニメストア", "DMM TV", "ABEMA", "Netflix", "Prime Video", "U-NEXT", "Disney+", "Hulu"];
const fallbackAnime = [
  { id: 2026001, title: { native: "今期作品を読み込み中" }, coverImage: { large: "" }, status: "RELEASING", episodes: null, siteUrl: "https://anilist.co", nextAiringEpisode: null }
];

let anime = [];
let activeFilter = "all";
let lineupPage = 1;
const LINEUP_PAGE_SIZE = 50;
let state = loadState();

function loadState() {
  try {
    return { favorites: [], prefecture: "", channels: [], services: [], overrides: {}, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
  } catch {
    return { favorites: [], prefecture: "", channels: [], services: [], overrides: {} };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function titleOf(item) {
  return item.title?.native || item.title?.english || item.title?.romaji || "タイトル未設定";
}

function scheduleOf(item) {
  const override = state.overrides[item.id];
  if (override) return { at: new Date(override.startAt), episode: override.episode || item.nextAiringEpisode?.episode, provider: override.provider, confirmed: true };
  if (!item.nextAiringEpisode) return null;
  return { at: new Date(item.nextAiringEpisode.airingAt * 1000), episode: item.nextAiringEpisode.episode, provider: "AniList公開予定", confirmed: false };
}

function upcomingItems(onlyFavorites = true) {
  return anime
    .filter(item => !onlyFavorites || state.favorites.includes(item.id))
    .map(item => ({ item, schedule: scheduleOf(item) }))
    .filter(row => row.schedule && row.schedule.at > new Date(Date.now() - 30 * 60 * 1000))
    .sort((a, b) => a.schedule.at - b.schedule.at);
}

function formatTime(date) {
  return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function formatDay(date) {
  const today = new Date();
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  if (date.toDateString() === today.toDateString()) return "今日";
  if (date.toDateString() === tomorrow.toDateString()) return "明日";
  return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", weekday: "short" }).format(date);
}

function countdown(date) {
  const mins = Math.max(0, Math.round((date - Date.now()) / 60000));
  if (mins < 60) return `あと${mins}分`;
  if (mins < 1440) return `あと${Math.floor(mins / 60)}時間${mins % 60}分`;
  return `あと${Math.floor(mins / 1440)}日`;
}

function escapeHtml(value = "") {
  const node = document.createElement("div"); node.textContent = value; return node.innerHTML;
}

function renderToday() {
  const date = new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "long" }).format(new Date());
  document.querySelector("#todayDate").textContent = date.toUpperCase();
  let rows = upcomingItems(true);
  const usingFallback = rows.length === 0;
  if (usingFallback) rows = upcomingItems(false).slice(0, 6);
  const first = rows[0];
  document.querySelector("#nextUp").innerHTML = first ? `
    <article class="next-card">
      <div class="next-time"><div><strong>${formatTime(first.schedule.at)}</strong><small>${formatDay(first.schedule.at)}</small></div></div>
      <div class="next-details"><h2>${escapeHtml(titleOf(first.item))}</h2><div class="meta"><span>第${first.schedule.episode || "?"}話</span><span>${escapeHtml(first.schedule.provider)}</span><span>${first.schedule.confirmed ? "自分で確認済み" : "参考時刻"}</span></div></div>
      <div class="countdown">${countdown(first.schedule.at)}</div>
    </article>` : `<div class="empty-state">次回予定を取得できませんでした。<br>更新ボタンを押すか、今期一覧から自分用予定を登録してください。</div>`;

  document.querySelector("#scheduleList").innerHTML = rows.length ? rows.slice(0, 10).map(({ item, schedule }) => `
    <article class="schedule-row">
      <div class="schedule-time"><strong>${formatTime(schedule.at)}</strong><small>${formatDay(schedule.at)}</small></div>
      <div class="schedule-info"><h3>${escapeHtml(titleOf(item))}</h3><p>第${schedule.episode || "?"}話 · ${escapeHtml(schedule.provider)}${usingFallback && !state.favorites.includes(item.id) ? " · 未登録" : ""}</p></div>
      <div class="schedule-actions"><button class="mini-button" data-action="override" data-id="${item.id}">補正</button><button class="mini-button" data-action="single-ics" data-id="${item.id}">ICS</button></div>
    </article>`).join("") : `<div class="empty-state">今期一覧で ☆ を押すと、ここに予定が並びます。</div>`;
}

function renderLineup() {
  const query = document.querySelector("#searchInput").value.trim().toLowerCase();
  const filtered = anime.filter(item => {
    if (query && !titleOf(item).toLowerCase().includes(query) && !(item.title?.romaji || "").toLowerCase().includes(query)) return false;
    if (activeFilter === "favorite" && !state.favorites.includes(item.id)) return false;
    if (activeFilter === "airing" && item.status !== "RELEASING") return false;
    return true;
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / LINEUP_PAGE_SIZE));
  if (lineupPage > totalPages) lineupPage = totalPages;
  if (lineupPage < 1) lineupPage = 1;
  const start = (lineupPage - 1) * LINEUP_PAGE_SIZE;
  const pageItems = filtered.slice(start, start + LINEUP_PAGE_SIZE);

  document.querySelector("#lineupCount").textContent = `${filtered.length}作品`;
  document.querySelector("#lineupGrid").innerHTML = pageItems.length ? pageItems.map(item => {
    const schedule = scheduleOf(item);
    const favorite = state.favorites.includes(item.id);
    const bg = item.coverImage?.large ? `style="background-image:url('${item.coverImage.large.replaceAll("'", "%27")}')"` : "";
    return `<article class="anime-card">
      <div class="anime-art" ${bg}></div>
      <button class="favorite-button ${favorite ? "active" : ""}" data-action="favorite" data-id="${item.id}" aria-label="${favorite ? "観たいから外す" : "観たいに追加"}">${favorite ? "★" : "☆"}</button>
      <div class="anime-content"><h3>${escapeHtml(titleOf(item))}</h3><p>${schedule ? `${formatDay(schedule.at)} ${formatTime(schedule.at)} · 第${schedule.episode || "?"}話` : "次回予定 未発表"}</p>
        <div class="card-actions"><button data-action="override" data-id="${item.id}">${state.overrides[item.id] ? "時刻を再補正" : "時刻を補正"}</button><a href="${item.siteUrl || "https://anilist.co"}" target="_blank" rel="noopener">出典</a></div>
      </div>
    </article>`;
  }).join("") : `<div class="empty-state">条件に合う作品がありません。</div>`;

  const paginationNode = document.querySelector("#lineupPagination");
  if (paginationNode) {
    paginationNode.innerHTML = totalPages > 1 ? `
      <button class="mini-button" type="button" data-page-action="prev" ${lineupPage <= 1 ? "disabled" : ""}>← 前の50件</button>
      <span class="page-indicator">${lineupPage} / ${totalPages} ページ</span>
      <button class="mini-button" type="button" data-page-action="next" ${lineupPage >= totalPages ? "disabled" : ""}>次の50件 →</button>
    ` : "";
  }
}

function renderSettings() {
  document.querySelector("#prefectureSelect").value = state.prefecture;
  renderChecks("#channelOptions", channels, state.channels, "channel");
  renderChecks("#serviceOptions", services, state.services, "service");
  const urlNode = document.querySelector("#subscriptionUrlDisplay");
  if (urlNode) urlNode.textContent = `購読URL: webcal://${location.host}${location.pathname.replace(/index\.html$/, "")}calendar.ics`;
}

function renderChecks(selector, values, selected, name) {
  document.querySelector(selector).innerHTML = values.map(value => `<label class="check-option"><input type="checkbox" name="${name}" value="${value}" ${selected.includes(value) ? "checked" : ""}><span>${value}</span></label>`).join("");
}

function renderAll() { renderToday(); renderLineup(); renderSettings(); }

async function fetchAnime(force = false) {
  const button = document.querySelector("#refreshButton"); button.classList.add("loading");
  if (!force) {
    try {
      const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (cache && Date.now() - cache.savedAt < 6 * 60 * 60 * 1000) anime = cache.items;
    } catch {}
  }
  if (!anime.length || force) {
    const query = `query ($page: Int, $perPage: Int) { Page(page: $page, perPage: $perPage) { pageInfo { hasNextPage } media(type: ANIME, season: SUMMER, seasonYear: 2026, countryOfOrigin: "JP", sort: [START_DATE, POPULARITY_DESC], isAdult: false) { id title { native romaji english } coverImage { large } status episodes siteUrl nextAiringEpisode { episode airingAt } } } }`;
    const TARGET_TOTAL = 200;
    const PER_PAGE = 50;
    try {
      const collected = [];
      let page = 1;
      let hasNextPage = true;
      while (hasNextPage && collected.length < TARGET_TOTAL) {
        const response = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ query, variables: { page, perPage: PER_PAGE } }) });
        if (!response.ok) throw new Error(`API ${response.status}`);
        const json = await response.json();
        collected.push(...json.data.Page.media);
        hasNextPage = json.data.Page.pageInfo?.hasNextPage;
        page += 1;
        if (hasNextPage && collected.length < TARGET_TOTAL) await new Promise(resolve => setTimeout(resolve, 1500));
      }
      anime = collected.slice(0, TARGET_TOTAL);
      localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), items: anime }));
      if (force) showToast("番組情報を更新しました");
    } catch (error) {
      if (!anime.length) anime = fallbackAnime;
      showToast("通信できないため保存済みデータを表示します");
    }
  }
  button.classList.remove("loading"); renderAll();
}

function toggleFavorite(id) {
  state.favorites = state.favorites.includes(id) ? state.favorites.filter(value => value !== id) : [...state.favorites, id];
  saveState(); renderAll(); showToast(state.favorites.includes(id) ? "「観たい」に追加しました" : "「観たい」から外しました");
}

function openOverride(id) {
  const item = anime.find(value => value.id === id); if (!item) return;
  const existing = state.overrides[id];
  document.querySelector("#overrideAnimeId").value = id;
  document.querySelector("#overrideTitle").textContent = titleOf(item);
  document.querySelector("#overrideProvider").value = existing?.provider || state.services[0] || state.channels[0] || "";
  const base = existing ? new Date(existing.startAt) : scheduleOf(item)?.at;
  document.querySelector("#overrideDateTime").value = base ? localInputValue(base) : "";
  document.querySelector("#deleteOverride").hidden = !existing;
  document.querySelector("#overrideDialog").showModal();
}

function localInputValue(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function saveOverride() {
  const id = Number(document.querySelector("#overrideAnimeId").value);
  const provider = document.querySelector("#overrideProvider").value.trim();
  const startAt = document.querySelector("#overrideDateTime").value;
  if (!provider || !startAt) return false;
  const item = anime.find(value => value.id === id);
  state.overrides[id] = { provider, startAt: new Date(startAt).toISOString(), episode: item?.nextAiringEpisode?.episode || null };
  if (!state.favorites.includes(id)) state.favorites.push(id);
  saveState(); renderAll(); showToast("自分用予定を保存しました"); return true;
}

function escapeICS(value) { return String(value).replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,").replaceAll("\n", "\\n"); }
function icsDate(date) { return date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}/, ""); }

function buildICSContent(items) {
  const events = items.map(({ item, schedule }) => {
    const end = new Date(schedule.at.getTime() + 30 * 60 * 1000);
    return ["BEGIN:VEVENT", `UID:miruyote-${item.id}-${schedule.episode || 0}@local`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(schedule.at)}`, `DTEND:${icsDate(end)}`, `SUMMARY:${escapeICS(`${titleOf(item)} 第${schedule.episode || "?"}話`)}`, `DESCRIPTION:${escapeICS(`${schedule.provider} / ${schedule.confirmed ? "自分用確認済み" : "AniList参考時刻。公式情報も確認してください。"}`)}`, "BEGIN:VALARM", "TRIGGER:-PT10M", "ACTION:DISPLAY", `DESCRIPTION:${escapeICS(`${titleOf(item)} まもなく開始`)}`, "END:VALARM", "END:VEVENT"].join("\r\n");
  }).join("\r\n");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Miruyote//Anime Schedule//JA", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:ミルヨテ", "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H", events, "END:VCALENDAR"].join("\r\n");
}

function exportICS(items = upcomingItems(true), filename = "miruyote.ics") {
  if (!items.length) { showToast("先に観たい作品を登録してください"); return; }
  const content = buildICSContent(items);
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = filename; link.click(); URL.revokeObjectURL(link.href);
  showToast(`${items.length}件の予定を書き出しました`);
}

function exportSubscriptionFeed() {
  const items = upcomingItems(true);
  if (!items.length) { showToast("先に観たい作品を登録してください"); return; }
  exportICS(items, "calendar.ics");
  showToast("calendar.ics を書き出しました。リポジトリ直下に置いてpushしてください");
}

function copySubscriptionUrl() {
  const url = `webcal://${location.host}${location.pathname.replace(/index\.html$/, "")}calendar.ics`;
  navigator.clipboard?.writeText(url).then(() => showToast("購読URLをコピーしました")).catch(() => showToast(url));
}

function showToast(message) {
  const toast = document.querySelector("#toast"); toast.textContent = message; toast.classList.add("show");
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function navigate() {
  const view = ["today", "lineup", "settings"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "today";
  document.querySelectorAll(".view").forEach(node => node.classList.toggle("active", node.id === `${view}View`));
  document.querySelectorAll(".bottom-nav a").forEach(node => node.classList.toggle("active", node.dataset.view === view));
  window.scrollTo({ top: 0 });
}

document.addEventListener("click", event => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  const id = Number(event.target.closest("[data-id]")?.dataset.id);
  if (action === "favorite") toggleFavorite(id);
  if (action === "override") openOverride(id);
  if (action === "single-ics") { const item = anime.find(value => value.id === id); if (item && scheduleOf(item)) exportICS([{ item, schedule: scheduleOf(item) }]); }
});
document.querySelector("#searchInput").addEventListener("input", () => { lineupPage = 1; renderLineup(); });
document.querySelectorAll(".filter-chip").forEach(button => button.addEventListener("click", () => { document.querySelectorAll(".filter-chip").forEach(node => node.classList.remove("active")); button.classList.add("active"); activeFilter = button.dataset.filter; lineupPage = 1; renderLineup(); }));
document.querySelector("#lineupView").addEventListener("click", event => {
  const pageAction = event.target.closest("[data-page-action]")?.dataset.pageAction;
  if (!pageAction) return;
  lineupPage += pageAction === "next" ? 1 : -1;
  renderLineup();
  document.querySelector("#lineupView").scrollIntoView({ block: "start" });
});
document.querySelector("#prefectureSelect").addEventListener("change", event => { state.prefecture = event.target.value; saveState(); showToast("都道府県を保存しました"); });
document.querySelector("#settingsView").addEventListener("change", event => {
  if (!event.target.matches("input[type=checkbox]")) return;
  const key = event.target.name === "channel" ? "channels" : "services";
  state[key] = [...document.querySelectorAll(`input[name=${event.target.name}]:checked`)].map(node => node.value); saveState();
});
document.querySelector("#overrideForm").addEventListener("submit", event => { if (event.submitter?.value === "save" && !saveOverride()) event.preventDefault(); });
document.querySelector("#deleteOverride").addEventListener("click", () => { const id = Number(document.querySelector("#overrideAnimeId").value); delete state.overrides[id]; saveState(); document.querySelector("#overrideDialog").close(); renderAll(); showToast("補正を削除しました"); });
document.querySelector("#refreshButton").addEventListener("click", () => fetchAnime(true));
document.querySelector("#exportCalendarTop").addEventListener("click", () => exportICS());
document.querySelector("#exportCalendarSettings").addEventListener("click", () => exportICS());
document.querySelector("#exportSubscriptionFeed")?.addEventListener("click", exportSubscriptionFeed);
document.querySelector("#copySubscriptionUrl")?.addEventListener("click", copySubscriptionUrl);
window.addEventListener("hashchange", navigate);

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));
navigate();
document.querySelector("#scheduleList").innerHTML = "<div class='skeleton'></div><div class='skeleton'></div>";
fetchAnime();
