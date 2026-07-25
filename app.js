const API_URL = "https://graphql.anilist.co";
const STORAGE_KEY = "miruyote-state-v1";
const ACTIVE_SEASON = currentAnimeSeason();
const CACHE_KEY = `miruyote-anilist-cache-v3-${ACTIVE_SEASON.year}-${ACTIVE_SEASON.season}`;
const SEASON_LABELS = { WINTER: "WINTER", SPRING: "SPRING", SUMMER: "SUMMER", FALL: "FALL" };
const channels = ["TOKYO MX", "テレビ愛知", "MBS", "ABCテレビ", "BS11", "BS日テレ", "AT-X", "その他"];
const services = ["dアニメストア", "DMM TV", "ABEMA", "Netflix", "Prime Video", "U-NEXT", "Disney+", "Hulu"];
const fallbackAnime = [
  { id: 2026001, title: { native: "今期作品を読み込み中" }, coverImage: { large: "" }, status: "RELEASING", episodes: null, siteUrl: "https://anilist.co", nextAiringEpisode: null }
];

let anime = [];
let activeFilter = "all";
let lineupPage = 1;
let pendingCalendarExport = null;
const LINEUP_PAGE_SIZE = 100;
const OBVIOUS_RERUN_JA_PATTERN = /(?:再放送|再編集版|傑作選|セレクション放送|リピート放送|アンコール放送)/;
const OBVIOUS_RERUN_LATIN_PATTERN = /(?:^|[^a-z0-9])(?:re-?broadcast(?:s|ed|ing)?|re-?air(?:s|ed|ing)?|re-?run(?:s|ning)?)(?:$|[^a-z0-9])/i;
let state = loadState();

function currentAnimeSeason(date = new Date()) {
  const month = date.getMonth() + 1;
  const season = month <= 3 ? "WINTER" : month <= 6 ? "SPRING" : month <= 9 ? "SUMMER" : "FALL";
  return { season, year: date.getFullYear() };
}

function normalizeEpisode(value) {
  const episode = Number(value);
  return Number.isSafeInteger(episode) && episode > 0 && episode <= 100000 ? episode : null;
}

function episodeLabel(value, fallback = "?") {
  return String(normalizeEpisode(value) ?? fallback);
}

function normalizeState(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const favoriteIds = Array.isArray(source.favorites)
    ? source.favorites.map(Number).filter(id => Number.isSafeInteger(id) && id > 0).slice(0, 1000)
    : [];
  const rawOverrides = source.overrides && typeof source.overrides === "object" && !Array.isArray(source.overrides) ? source.overrides : {};
  const overrides = {};
  for (const [key, value] of Object.entries(rawOverrides).slice(0, 500)) {
    const id = Number(key);
    if (!Number.isSafeInteger(id) || id <= 0 || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const provider = typeof value.provider === "string" ? value.provider.trim().slice(0, 160) : "";
    const start = typeof value.startAt === "string" ? new Date(value.startAt) : new Date(Number.NaN);
    if (!provider || !Number.isFinite(start.getTime())) continue;
    overrides[id] = {
      provider,
      startAt: start.toISOString(),
      episode: normalizeEpisode(value.episode)
    };
  }
  return {
    favorites: [...new Set(favoriteIds)],
    prefecture: typeof source.prefecture === "string" ? source.prefecture.slice(0, 50) : "",
    channels: Array.isArray(source.channels) ? source.channels.filter(value => channels.includes(value)) : [],
    services: Array.isArray(source.services) ? source.services.filter(value => services.includes(value)) : [],
    overrides
  };
}

function loadState() {
  try {
    return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"));
  } catch {
    return normalizeState();
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    showToast("端末への保存に失敗しました。設定バックアップを作成してください");
    return false;
  }
}

async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

function titleOf(item) {
  return item.title?.native || item.title?.english || item.title?.romaji || "タイトル未設定";
}

function isObviousRerun(item) {
  const names = [
    item.title?.native,
    item.title?.romaji,
    item.title?.english,
    ...(Array.isArray(item.synonyms) ? item.synonyms : [])
  ].filter(Boolean);
  return names.some(name => OBVIOUS_RERUN_JA_PATTERN.test(name) || OBVIOUS_RERUN_LATIN_PATTERN.test(name));
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function coverOf(item, size = "large") {
  return safeHttpsUrl(item.coverImage?.[size] || item.coverImage?.large || "");
}

function scheduleOf(item) {
  const override = state.overrides[item.id];
  if (override) return { at: new Date(override.startAt), episode: override.episode ?? normalizeEpisode(item.nextAiringEpisode?.episode), provider: override.provider, confirmed: true };
  if (!item.nextAiringEpisode) return null;
  return { at: new Date(item.nextAiringEpisode.airingAt * 1000), episode: normalizeEpisode(item.nextAiringEpisode.episode), provider: "AniList公開予定", confirmed: false };
}

function compareLineup(a, b) {
  const favoriteDifference = Number(state.favorites.includes(b.id)) - Number(state.favorites.includes(a.id));
  if (favoriteDifference) return favoriteDifference;
  const aTime = scheduleOf(a)?.at?.getTime() ?? Number.POSITIVE_INFINITY;
  const bTime = scheduleOf(b)?.at?.getTime() ?? Number.POSITIVE_INFINITY;
  if (aTime !== bTime) return aTime - bTime;
  return titleOf(a).localeCompare(titleOf(b), "ja");
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

function escapeAttr(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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
      <div class="next-details"><h2>${escapeHtml(titleOf(first.item))}</h2><div class="meta"><span>第${episodeLabel(first.schedule.episode)}話</span><span>${escapeHtml(first.schedule.provider)}</span><span>${first.schedule.confirmed ? "自分で確認済み" : "参考時刻"}</span></div></div>
      <div class="countdown">${countdown(first.schedule.at)}</div>
    </article>` : `<div class="empty-state">次回予定を取得できませんでした。<br>更新ボタンを押すか、今期一覧から自分用予定を登録してください。</div>`;

  document.querySelector("#scheduleList").innerHTML = rows.length ? rows.slice(0, 10).map(({ item, schedule }) => `
    <article class="schedule-row">
      <div class="schedule-thumb ${coverOf(item, "medium") ? "" : "missing"}">
        ${coverOf(item, "medium") ? `<img class="schedule-thumb-image" src="${escapeAttr(coverOf(item, "medium"))}" alt="" width="58" height="87" loading="lazy" decoding="async" />` : ""}
        <span class="schedule-thumb-fallback" aria-hidden="true">▶</span>
      </div>
      <div class="schedule-row-body">
        <div class="schedule-time"><strong>${formatTime(schedule.at)}</strong><small>${formatDay(schedule.at)}</small></div>
        <div class="schedule-info"><h3>${escapeHtml(titleOf(item))}</h3><p>第${episodeLabel(schedule.episode)}話 · ${escapeHtml(schedule.provider)}${usingFallback && !state.favorites.includes(item.id) ? " · 未登録" : ""}</p></div>
        <div class="schedule-actions"><button class="mini-button" data-action="override" data-id="${item.id}" aria-label="${escapeAttr(titleOf(item))}の予定を補正">補正</button><button class="mini-button" data-action="single-ics" data-id="${item.id}" aria-label="${escapeAttr(titleOf(item))}のカレンダー登録を開く">ICS</button></div>
      </div>
    </article>`).join("") : `<div class="empty-state">今期一覧で ☆ を押すと、ここに予定が並びます。</div>`;
}

function renderLineup() {
  const query = document.querySelector("#searchInput").value.trim().toLowerCase();
  const filtered = anime.filter(item => {
    if (query && !titleOf(item).toLowerCase().includes(query) && !(item.title?.romaji || "").toLowerCase().includes(query)) return false;
    if (activeFilter === "favorite" && !state.favorites.includes(item.id)) return false;
    if (activeFilter === "airing" && item.status !== "RELEASING") return false;
    return true;
  }).sort(compareLineup);
  const totalPages = Math.max(1, Math.ceil(filtered.length / LINEUP_PAGE_SIZE));
  if (lineupPage > totalPages) lineupPage = totalPages;
  if (lineupPage < 1) lineupPage = 1;
  const start = (lineupPage - 1) * LINEUP_PAGE_SIZE;
  const pageItems = filtered.slice(start, start + LINEUP_PAGE_SIZE);

  document.querySelector("#lineupCount").textContent = `${filtered.length}作品`;
  const seasonLabel = document.querySelector("#seasonLabel");
  if (seasonLabel) seasonLabel.textContent = `${SEASON_LABELS[ACTIVE_SEASON.season]} ${ACTIVE_SEASON.year}`;
  document.querySelector("#lineupGrid").innerHTML = pageItems.length ? pageItems.map(item => {
    const schedule = scheduleOf(item);
    const favorite = state.favorites.includes(item.id);
    const cover = coverOf(item, "large");
    const sourceUrl = safeHttpsUrl(item.siteUrl) || "https://anilist.co";
    return `<article class="anime-card">
      <div class="anime-art ${cover ? "" : "missing"}">
        ${cover ? `<img class="anime-art-image" src="${escapeAttr(cover)}" alt="" width="320" height="480" loading="lazy" decoding="async" fetchpriority="low" />` : ""}
        <span class="anime-art-fallback" aria-hidden="true">▶</span>
      </div>
      <span class="anime-status-badge">${item.status === "RELEASING" ? "● 放送中" : "放送予定"}</span>
      <button class="favorite-button ${favorite ? "active" : ""}" data-action="favorite" data-id="${item.id}" aria-label="${favorite ? "観たいから外す" : "観たいに追加"}" aria-pressed="${favorite}">${favorite ? "★" : "☆"}</button>
      <div class="anime-content"><h3>${escapeHtml(titleOf(item))}</h3><p>${schedule ? `${formatDay(schedule.at)} ${formatTime(schedule.at)} · 第${episodeLabel(schedule.episode)}話` : "次回予定 未発表"}</p>
        <div class="card-actions"><button data-action="override" data-id="${item.id}">${state.overrides[item.id] ? "時刻を再補正" : "時刻を補正"}</button><a href="${escapeAttr(sourceUrl)}" target="_blank" rel="noopener">出典</a></div>
      </div>
    </article>`;
  }).join("") : `<div class="empty-state">条件に合う作品がありません。</div>`;

  const paginationNode = document.querySelector("#lineupPagination");
  if (paginationNode) {
    paginationNode.innerHTML = totalPages > 1 ? `
      <button class="mini-button" type="button" data-page-action="prev" ${lineupPage <= 1 ? "disabled" : ""}>← 前の100件</button>
      <span class="page-indicator">${lineupPage} / ${totalPages} ページ</span>
      <button class="mini-button" type="button" data-page-action="next" ${lineupPage >= totalPages ? "disabled" : ""}>次の100件 →</button>
    ` : "";
  }
  const pageStatus = document.querySelector("#lineupPageStatus");
  if (pageStatus) pageStatus.textContent = totalPages > 1
    ? `${lineupPage} / ${totalPages} ページ、${pageItems.length}作品を表示中`
    : `${filtered.length}作品を表示中`;
}

function renderSettings() {
  document.querySelector("#prefectureSelect").value = state.prefecture;
  renderChecks("#channelOptions", channels, state.channels, "channel");
  renderChecks("#serviceOptions", services, state.services, "service");
  const urlNode = document.querySelector("#subscriptionUrlDisplay");
  if (urlNode) urlNode.textContent = `購読URL: webcal://${location.host}${location.pathname.replace(/index\.html$/, "")}calendar.ics`;
  const calendarStatus = document.querySelector("#calendarStatus");
  if (calendarStatus) calendarStatus.textContent = state.favorites.length ? `現在「観たい」${state.favorites.length}作品` : "先に「今期」で観たい作品へ★を付けてください";
  const storageStatus = document.querySelector("#storageStatus");
  if (storageStatus) storageStatus.textContent = `保存済み：お気に入り${state.favorites.length}作品・時刻補正${Object.keys(state.overrides).length}件`;
}

function renderChecks(selector, values, selected, name) {
  document.querySelector(selector).innerHTML = values.map(value => `<label class="check-option"><input type="checkbox" name="${name}" value="${value}" ${selected.includes(value) ? "checked" : ""}><span>${value}</span></label>`).join("");
}

function renderAll() { renderToday(); renderLineup(); renderSettings(); }

async function fetchAnime(force = false) {
  const button = document.querySelector("#refreshButton"); button.classList.add("loading");
  let cachedAnime = [];
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (cache && Array.isArray(cache.items)) {
      cachedAnime = cache.items;
      if (!force && Date.now() - cache.savedAt < 6 * 60 * 60 * 1000) anime = cache.items;
    }
  } catch {}
  if (!anime.length || force) {
    const seasonalQuery = `query ($page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int) { Page(page: $page, perPage: $perPage) { pageInfo { hasNextPage } media(type: ANIME, season: $season, seasonYear: $seasonYear, countryOfOrigin: "JP", sort: [START_DATE, POPULARITY_DESC], isAdult: false) { id title { native romaji english } synonyms coverImage { large medium } status episodes siteUrl nextAiringEpisode { episode airingAt } } } }`;
    const ongoingQuery = `query ($page: Int, $perPage: Int) { Page(page: $page, perPage: $perPage) { pageInfo { hasNextPage } media(type: ANIME, status: RELEASING, countryOfOrigin: "JP", sort: [POPULARITY_DESC], isAdult: false) { id title { native romaji english } synonyms coverImage { large medium } status episodes siteUrl nextAiringEpisode { episode airingAt } } } }`;
    const TARGET_TOTAL = 250;
    const PER_PAGE = 50;
    try {
      const fetchPages = async (query, variables) => {
        const items = [];
        let page = 1;
        let hasNextPage = true;
        while (hasNextPage && items.length < TARGET_TOTAL) {
          const response = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ query, variables: { ...variables, page, perPage: PER_PAGE } })
          });
          if (!response.ok) throw new Error(`API ${response.status}`);
          const json = await response.json();
          if (json.errors?.length) throw new Error(json.errors[0].message);
          items.push(...json.data.Page.media);
          hasNextPage = json.data.Page.pageInfo?.hasNextPage;
          page += 1;
          if (hasNextPage && items.length < TARGET_TOTAL) await new Promise(resolve => setTimeout(resolve, 800));
        }
        return items;
      };
      const seasonal = await fetchPages(seasonalQuery, {
        season: ACTIVE_SEASON.season,
        seasonYear: ACTIVE_SEASON.year
      });
      anime = seasonal.filter(item => !isObviousRerun(item));
      renderAll();
      const ongoing = await fetchPages(ongoingQuery, {});
      const unique = new Map([...seasonal, ...ongoing].map(item => [item.id, item]));
      anime = [...unique.values()]
        .filter(item => !isObviousRerun(item))
        .slice(0, TARGET_TOTAL);
      localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), items: anime }));
      if (force) showToast("番組情報を更新しました");
    } catch (error) {
      let message = "通信が途中で止まったため、取得できた番組データを表示します";
      if (!anime.length && cachedAnime.length) {
        anime = cachedAnime;
        message = "通信できないため、前回保存した番組データを表示します";
      } else if (!anime.length) {
        anime = fallbackAnime;
        message = "通信できないため、サンプルデータを表示します";
      }
      showToast(message);
    }
  }
  button.classList.remove("loading"); renderAll();
}

function toggleFavorite(id) {
  state.favorites = state.favorites.includes(id) ? state.favorites.filter(value => value !== id) : [...state.favorites, id];
  const favorite = state.favorites.includes(id);
  saveState();
  requestPersistentStorage();
  renderToday();
  renderSettings();
  if (activeFilter === "favorite") {
    renderLineup();
  } else {
    const button = document.querySelector(`.favorite-button[data-id="${id}"]`);
    button?.classList.toggle("active", favorite);
    button?.setAttribute("aria-label", favorite ? "観たいから外す" : "観たいに追加");
    button?.setAttribute("aria-pressed", String(favorite));
    if (button) button.textContent = favorite ? "★" : "☆";
  }
  showToast(favorite ? "「観たい」に追加しました" : "「観たい」から外しました");
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
  const dialog = document.querySelector("#overrideDialog");
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeOverride() {
  const dialog = document.querySelector("#overrideDialog");
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
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
  state.overrides[id] = { provider, startAt: new Date(startAt).toISOString(), episode: normalizeEpisode(item?.nextAiringEpisode?.episode) };
  if (!state.favorites.includes(id)) state.favorites.push(id);
  lineupPage = 1;
  saveState();
  requestPersistentStorage();
  renderAll(); showToast("自分用予定を保存しました"); return true;
}

function escapeICS(value) { return String(value).replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,").replace(/\r\n?|\n/g, "\\n"); }
function icsDate(date) { return date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}/, ""); }

function foldICSLine(line) {
  const encoder = new TextEncoder();
  const folded = [];
  let chunk = "";
  for (const character of line) {
    if (encoder.encode(chunk + character).length > 75) {
      folded.push(chunk);
      chunk = ` ${character}`;
    } else {
      chunk += character;
    }
  }
  folded.push(chunk);
  return folded.join("\r\n");
}

function buildICSContent(items) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Miruyote//Anime Schedule//JA",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:ミルヨテ",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H"
  ];
  for (const { item, schedule } of items) {
    const end = new Date(schedule.at.getTime() + 30 * 60 * 1000);
    lines.push(
      "BEGIN:VEVENT",
      `UID:miruyote-${item.id}-${episodeLabel(schedule.episode, "0")}@local`,
      `DTSTAMP:${icsDate(new Date())}`,
      `DTSTART:${icsDate(schedule.at)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${escapeICS(`${titleOf(item)} 第${episodeLabel(schedule.episode)}話`)}`,
      `DESCRIPTION:${escapeICS(`${schedule.provider} / ${schedule.confirmed ? "自分用確認済み" : "AniList参考時刻。公式情報も確認してください。"}`)}`,
      "BEGIN:VALARM",
      "TRIGGER:-PT10M",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeICS(`${titleOf(item)} まもなく開始`)}`,
      "END:VALARM",
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldICSLine).join("\r\n") + "\r\n";
}
function createICSFile(items, filename = "miruyote.ics") {
  return new File([buildICSContent(items)], filename, { type: "text/calendar" });
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function isIOSDevice() {
  return /iP(?:hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function openCalendarGuide(file, itemCount) {
  pendingCalendarExport = { file, itemCount };
  const countNode = document.querySelector("#calendarGuideCount");
  if (countNode) countNode.textContent = `${itemCount}件の予定を1つのICSにまとめました`;
  const noteNode = document.querySelector("#calendarGuideNote");
  if (noteNode) noteNode.textContent = "「ファイル」に保存したICSからカレンダーが開かない場合でも、このメール経由なら登録できます。";
  const downloadButton = document.querySelector("#downloadCalendarFile");
  if (downloadButton) { downloadButton.disabled = false; downloadButton.textContent = "ICSだけ保存"; }
  const dialog = document.querySelector("#calendarGuideDialog");
  if (typeof dialog?.showModal === "function") dialog.showModal();
  else dialog?.setAttribute("open", "");
}

function closeCalendarGuide() {
  const dialog = document.querySelector("#calendarGuideDialog");
  if (typeof dialog?.close === "function") dialog.close();
  else dialog?.removeAttribute("open");
  pendingCalendarExport = null;
}

function openCalendarFallback(items = upcomingItems(true), filename = "miruyote.ics") {
  if (!items.length) {
    showToast("先に今期一覧で観たい作品へ★を付けてください");
    location.hash = "lineup";
    return;
  }
  openCalendarGuide(createICSFile(items, filename), items.length);
}

async function shareCalendarByMail() {
  if (!pendingCalendarExport) return;
  const { file, itemCount } = pendingCalendarExport;
  const shareData = { title: "ミルヨテのアニメ予定", files: [file] };
  if (navigator.share && navigator.canShare?.(shareData)) {
    try {
      await navigator.share(shareData);
      closeCalendarGuide();
      showToast(`共有したメールのICSを開き、${itemCount}件を「すべて追加」してください`);
      return;
    } catch (error) {
      if (error?.name === "AbortError") {
        showToast("共有をキャンセルしました。登録手順はこの画面で確認できます");
        return;
      }
    }
  }
  const noteNode = document.querySelector("#calendarGuideNote");
  if (noteNode) noteNode.textContent = "共有画面を開けませんでした。「ICSだけ保存」の後、ファイルアプリでICSを長押しし、「共有」からApple純正のメールを選んでください。";
  showToast("共有を開けませんでした。画面内の予備手順を使ってください");
}

function downloadPendingCalendarFile() {
  if (!pendingCalendarExport) return;
  const { file, itemCount } = pendingCalendarExport;
  downloadFile(file);
  const noteNode = document.querySelector("#calendarGuideNote");
  if (noteNode) noteNode.textContent = "ICSを保存しました。ファイルアプリでICSを長押しし、「共有」→Apple純正の「メール」を選んで自分宛てに送ってください。";
  const button = document.querySelector("#downloadCalendarFile");
  if (button) button.textContent = "ICSをもう一度保存";
  showToast(`${itemCount}件のICSを保存しました。画面の手順でメールへ添付してください`);
}

async function exportICS(items = upcomingItems(true), filename = "miruyote.ics") {
  if (!items.length) {
    showToast("先に今期一覧で観たい作品へ★を付けてください");
    location.hash = "lineup";
    return;
  }
  if (isIOSDevice()) {
    const directFile = new File([buildICSContent(items)], filename, { type: "text/calendar;charset=utf-8" });
    downloadFile(directFile);
    showToast(`${items.length}件をカレンダーへ渡しました。開かない場合は「開けないとき」を使ってください`);
    return;
  }
  const file = createICSFile(items, filename);
  const shareData = { title: "ミルヨテのアニメ予定", files: [file] };
  if (navigator.share && navigator.canShare?.(shareData)) {
    try {
      await navigator.share(shareData);
      showToast(`${items.length}件の予定を共有しました`);
      return;
    } catch (error) {
      if (error?.name === "AbortError") {
        showToast("共有をキャンセルしました");
        return;
      }
    }
  }
  downloadFile(file);
  showToast(`${items.length}件のICSを保存しました`);
}

function exportSubscriptionFeed() {
  const items = upcomingItems(true);
  if (!items.length) {
    showToast("先に今期一覧で観たい作品へ★を付けてください");
    location.hash = "lineup";
    return;
  }
  downloadFile(createICSFile(items, "calendar.ics"));
  showToast(`${items.length}件の購読用calendar.icsを保存しました`);
}
async function copySubscriptionUrl() {
  const url = `webcal://${location.host}${location.pathname.replace(/index\.html$/, "")}calendar.ics`;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(url);
    showToast("購読URLをコピーしました");
  } catch {
    const field = document.createElement("textarea");
    field.value = url;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    field.setSelectionRange(0, field.value.length);
    const copied = document.execCommand("copy");
    field.remove();
    showToast(copied ? "購読URLをコピーしました" : url);
  }
}

async function exportSettingsBackup() {
  const payload = { version: 1, exportedAt: new Date().toISOString(), data: state };
  const day = new Date().toISOString().slice(0, 10);
  const file = new File([JSON.stringify(payload, null, 2)], `miruyote-backup-${day}.json`, { type: "application/json" });
  const shareData = { title: "ミルヨテ設定バックアップ", files: [file] };
  if (navigator.share && navigator.canShare?.(shareData)) {
    try {
      await navigator.share(shareData);
      showToast("設定バックアップを共有しました");
      return;
    } catch (error) {
      if (error?.name === "AbortError") {
        showToast("共有をキャンセルしました");
        return;
      }
    }
  }
  downloadFile(file);
  showToast("設定バックアップを保存しました");
}

async function importSettingsBackup(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const previousState = state;
  try {
    const payload = JSON.parse(await file.text());
    const importedState = normalizeState(payload?.data ?? payload);
    state = importedState;
    if (!saveState()) throw new Error("Storage unavailable");
    await requestPersistentStorage();
    lineupPage = 1;
    renderAll();
    showToast(`お気に入り${state.favorites.length}作品を含む設定を復元しました`);
  } catch {
    state = previousState;
    showToast("バックアップを読み込めませんでした");
  } finally {
    event.target.value = "";
  }
}

function showToast(message) {
  const toast = document.querySelector("#toast"); toast.textContent = message; toast.classList.add("show");
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function navigate() {
  const view = ["today", "lineup", "settings"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "today";
  document.querySelectorAll(".view").forEach(node => node.classList.toggle("active", node.id === `${view}View`));
  document.querySelectorAll(".bottom-nav a").forEach(node => {
    const active = node.dataset.view === view;
    node.classList.toggle("active", active);
    if (active) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  });
  window.scrollTo({ top: 0 });
}

document.addEventListener("error", event => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement)) return;
  if (!image.classList.contains("schedule-thumb-image") && !image.classList.contains("anime-art-image")) return;
  image.hidden = true;
  image.parentElement?.classList.add("missing");
}, true);
document.addEventListener("click", event => {
  const target = event.target instanceof Element ? event.target : null;
  const action = target?.closest("[data-action]")?.dataset.action;
  const id = Number(target?.closest("[data-id]")?.dataset.id);
  if (action === "favorite") toggleFavorite(id);
  if (action === "override") openOverride(id);
  if (action === "single-ics") { const item = anime.find(value => value.id === id); if (item && scheduleOf(item)) exportICS([{ item, schedule: scheduleOf(item) }]); }
});
document.querySelector("#searchInput").addEventListener("input", () => { lineupPage = 1; renderLineup(); });
document.querySelectorAll(".filter-chip").forEach(button => button.addEventListener("click", () => { document.querySelectorAll(".filter-chip").forEach(node => { const active = node === button; node.classList.toggle("active", active); node.setAttribute("aria-pressed", String(active)); }); activeFilter = button.dataset.filter; lineupPage = 1; renderLineup(); }));
document.querySelector("#lineupView").addEventListener("click", event => {
  const target = event.target instanceof Element ? event.target : null;
  const pageAction = target?.closest("[data-page-action]")?.dataset.pageAction;
  if (!pageAction) return;
  lineupPage += pageAction === "next" ? 1 : -1;
  renderLineup();
  document.querySelector("#lineupView").scrollIntoView({ block: "start" });
  document.querySelector("#lineupTitle")?.focus({ preventScroll: true });
});
document.querySelector("#prefectureSelect").addEventListener("change", event => { state.prefecture = event.target.value; saveState(); showToast("都道府県を保存しました"); });
document.querySelector("#settingsView").addEventListener("change", event => {
  if (!event.target.matches("input[type=checkbox]")) return;
  const key = event.target.name === "channel" ? "channels" : "services";
  state[key] = [...document.querySelectorAll(`input[name=${event.target.name}]:checked`)].map(node => node.value); saveState();
});
document.querySelector("#overrideForm").addEventListener("submit", event => {
  event.preventDefault();
  if (saveOverride()) closeOverride();
});
document.querySelector("#overrideClose").addEventListener("click", closeOverride);
document.querySelector("#deleteOverride").addEventListener("click", () => { const id = Number(document.querySelector("#overrideAnimeId").value); delete state.overrides[id]; saveState(); closeOverride(); renderAll(); showToast("補正を削除しました"); });
document.querySelector("#refreshButton").addEventListener("click", () => fetchAnime(true));
document.querySelector("#exportCalendarTop").addEventListener("click", () => exportICS());
document.querySelector("#exportCalendarSettings").addEventListener("click", () => exportICS());
document.querySelector("#openCalendarHelpTop")?.addEventListener("click", () => openCalendarFallback());
document.querySelector("#openCalendarHelpSettings")?.addEventListener("click", () => openCalendarFallback());
document.querySelector("#calendarGuideClose")?.addEventListener("click", closeCalendarGuide);
document.querySelector("#shareCalendarByMail")?.addEventListener("click", shareCalendarByMail);
document.querySelector("#downloadCalendarFile")?.addEventListener("click", downloadPendingCalendarFile);
document.querySelector("#calendarGuideDialog")?.addEventListener("cancel", () => { pendingCalendarExport = null; });
document.querySelector("#exportSubscriptionFeed")?.addEventListener("click", exportSubscriptionFeed);
document.querySelector("#copySubscriptionUrl")?.addEventListener("click", copySubscriptionUrl);
document.querySelector("#exportSettingsBackup")?.addEventListener("click", exportSettingsBackup);
document.querySelector("#importSettingsInput")?.addEventListener("change", importSettingsBackup);
window.addEventListener("hashchange", navigate);

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));
navigate();
document.querySelector("#scheduleList").innerHTML = "<div class='skeleton'></div><div class='skeleton'></div>";
fetchAnime();
