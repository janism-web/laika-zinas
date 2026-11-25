'use strict';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

/* ---------- Konfigurācija ---------- */

const CITIES = {
  saulkrasti: {
    name: 'Saulkrasti',
    sub: 'Piekrastes josla, Vidzeme',
    lat: 57.26,
    lon: 24.41,
    marine: { lat: 57.26, lon: 24.38 }
  },
  centrs: {
    name: 'Rīgas centrs',
    sub: 'Pilsētas centra zona',
    lat: 56.95,
    lon: 24.11
  },
  vecmilgravis: {
    name: 'Vecmīlgrāvis',
    sub: 'Ziemeļu rajons, piekrastes ieteka',
    lat: 57.03,
    lon: 24.10
  }
};

const CITY_ORDER = Object.keys(CITIES);
const MONTHS_LV = ['janv.', 'febr.', 'marts', 'apr.', 'maijs', 'jūn.', 'jūl.', 'aug.', 'sept.', 'okt.', 'nov.', 'dec.'];
const WEEKDAYS_LV = ['Svētdiena', 'Pirmdiena', 'Otrdiena', 'Trešdiena', 'Ceturtdiena', 'Piektdiena', 'Sestdiena'];

const CAM_SRC = 'https://g0.ipcamlive.com/player/player.php?alias=59171eddc8080';
const FETCH_TIMEOUT_MS = 12000;
const EXTRA_CACHE_MS = 30 * 60 * 1000;   // NOAA un jūras temperatūra mainās lēni
const FRESH_MS = 10 * 60 * 1000;         // tik jauniem datiem nav jāvelk no jauna
const STALE_MS = 30 * 60 * 1000;
const HOURS_AHEAD = 24;
const ICE_LOOKAHEAD_H = 6;

/* ---------- WMO kodi (viena patiesības tabula) ---------- */

const WMO = {};
function defWmo(codes, desc, icon, flags = {}) {
  codes.forEach((c) => {
    WMO[c] = { desc, icon, wet: !!flags.wet, snow: !!flags.snow, ice: !!flags.ice };
  });
}
defWmo([0], 'Skaidrs', 'clear_day');
defWmo([1], 'Pārsvarā skaidrs', 'partly_cloudy_day');
defWmo([2], 'Daļēji mākoņains', 'partly_cloudy_day');
defWmo([3], 'Apmācies', 'cloud');
defWmo([45, 48], 'Migla', 'foggy');
defWmo([51, 53, 55], 'Smalks lietus', 'rainy', { wet: true });
defWmo([56, 57], 'Sasalstošs smalks lietus', 'ac_unit', { wet: true, ice: true });
defWmo([61, 63, 65], 'Lietus', 'rainy', { wet: true });
defWmo([66, 67], 'Atkala', 'ac_unit', { wet: true, ice: true });
defWmo([71, 73, 75, 77], 'Sniegs', 'ac_unit', { wet: true, snow: true });
defWmo([80, 81, 82], 'Lietusgāzes', 'rainy', { wet: true });
defWmo([85, 86], 'Sniega gāzes', 'weather_snowy', { wet: true, snow: true });
defWmo([95, 96, 99], 'Negaiss', 'thunderstorm', { wet: true });

const WMO_FALLBACK = { desc: 'Mākoņains', icon: 'cloud', wet: false, snow: false, ice: false };
function decodeWMO(code) {
  return WMO[code] || WMO_FALLBACK;
}

/* ---------- Stāvoklis ---------- */

const urlParams = new URLSearchParams(window.location.search);
const paramCity = urlParams.get('city');
let savedCity = null;
try { savedCity = localStorage.getItem('laika_zinas_city'); } catch (e) {}

let currentCityKey = (paramCity && CITIES[paramCity]) ? paramCity : ((savedCity && CITIES[savedCity]) ? savedCity : 'saulkrasti');
let cachedHourlyData = null;
let cachedDailyData = null;
let lastCloudCover = null;
let selectedDateString = null;
let activeFetchController = null;
let lastFetchTimestamp = 0;
let auroraCache = { t: 0, data: null };
let seaCache = { t: 0, data: null };

/* ---------- Palīgfunkcijas ---------- */

const RIGA_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Riga',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

/** Pašreizējais laiks Rīgas joslā neatkarīgi no ierīces laika joslas */
function rigaNow() {
  const p = {};
  RIGA_FMT.formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, hour: parseInt(p.hour, 10), stamp: `${date}T${p.hour}:${p.minute}` };
}

/** Droši parsē YYYY-MM-DD kā kalendāra datumu (neatkarīgi no UTC nobīdes) */
function parseLocalDate(isoDateStr) {
  const [y, m, d] = isoDateStr.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

const pad2 = (n) => String(n).padStart(2, '0');
const signed = (n) => `${n > 0 ? '+' : ''}${n}°`;

function setSvgIcon(svgEl, iconName) {
  if (!svgEl) return;
  const useEl = svgEl.querySelector('use');
  if (useEl) useEl.setAttribute('href', `#i-${iconName}`);
}

function makeIcon(name, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

function makeEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function scrollBehavior() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function getWindClass(speed) {
  if (speed >= 15.0) return 'wind-gale';
  if (speed >= 10.0) return 'wind-strong';
  return '';
}

const WIND_DIRS = ['Z', 'ZA', 'A', 'DA', 'D', 'DR', 'R', 'ZR'];
function getWindDirection(deg) {
  return WIND_DIRS[Math.round(deg / 45) % 8];
}

function setUpdateTime(text, ok) {
  const el = document.getElementById('updateTime');
  if (!el) return;
  el.textContent = text;
  if (ok) el.dataset.ok = text;
}

/* ---------- Pilsētas ---------- */

function applyCityUI(cityKey) {
  document.querySelectorAll('.city-btn').forEach((btn) => {
    const active = btn.dataset.city === cityKey;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  document.getElementById('selectedCityName').textContent = CITIES[cityKey].name;
  document.getElementById('selectedCitySub').textContent = CITIES[cityKey].sub;

  const isCoast = !!CITIES[cityKey].marine;
  const seaPill = document.getElementById('seaTempPill');
  if (seaPill) seaPill.style.display = isCoast ? 'flex' : 'none';
  const webcamBtn = document.getElementById('webcamBtn');
  if (webcamBtn) webcamBtn.style.display = cityKey === 'saulkrasti' ? 'inline-flex' : 'none';
}

function switchCity(cityKey) {
  if (currentCityKey === cityKey) return;
  currentCityKey = cityKey;
  try { localStorage.setItem('laika_zinas_city', cityKey); } catch (e) {}

  applyCityUI(cityKey);
  selectedDateString = null;
  const snap = restoreCachedCitySnapshot(cityKey);
  updateStatsGridLayout();
  if (snap.found && snap.age < FRESH_MS) return;   // dati vēl svaigi, tīklu netērējam
  fetchWeatherData();
}

/** Momentāni ielādē pēdējos saglabātos datus pirms tīkla atbildes */
function restoreCachedCitySnapshot(cityKey) {
  const none = { found: false, age: Infinity };
  try {
    const raw = localStorage.getItem(`laika_zinas_cache_${cityKey}`);
    if (!raw) return none;
    const snap = JSON.parse(raw);
    if (!snap || !snap.forecast || !snap.forecast.current) return none;

    cachedHourlyData = snap.forecast.hourly;
    cachedDailyData = snap.forecast.daily;
    lastCloudCover = snap.forecast.current.cloud_cover;
    renderCurrent(snap.forecast.current);
    evaluateSmartAlerts(snap.forecast.current);
    renderDaily(snap.forecast.daily);
    renderHourly({ scroll: true });
    if (typeof snap.seaTemp === 'number' && CITIES[cityKey].marine) {
      const valEl = document.getElementById('seaTempValue');
      if (valEl) valEl.textContent = `${snap.seaTemp > 0 ? '+' : ''}${snap.seaTemp.toFixed(1)} °C`;
      const pill = document.getElementById('seaTempPill');
      if (pill) pill.style.display = 'flex';
    }
    if (snap.updatedAt) setUpdateTime(snap.updatedAt, true);
    return { found: true, age: snap.savedAt ? Date.now() - snap.savedAt : Infinity };
  } catch (e) {
    return none;
  }
}

/* ---------- Datu ielāde ---------- */

async function fetchWeatherData(showTopBar = false) {
  if (activeFetchController) activeFetchController.abort();
  const controller = new AbortController();
  activeFetchController = controller;
  const { signal } = controller;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, FETCH_TIMEOUT_MS);

  const badge = document.getElementById('refreshBtn');
  const progressBar = document.getElementById('syncProgressBar');
  if (badge) badge.classList.add('refreshing');
  if (showTopBar && progressBar) progressBar.classList.add('active');

  const cityKey = currentCityKey;
  const city = CITIES[cityKey];

  const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}` +
    '&current=temperature_2m,apparent_temperature,precipitation,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility' +
    '&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,visibility' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant,sunrise,sunset' +
    '&wind_speed_unit=ms&timezone=Europe%2FRiga&forecast_days=8';
  const auroraUrl = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';

  const now = Date.now();
  const needAurora = now - auroraCache.t > EXTRA_CACHE_MS;
  const needSea = !!city.marine && now - seaCache.t > EXTRA_CACHE_MS;

  try {
    const requests = [
      fetch(forecastUrl, { signal }).then((r) => {
        if (!r.ok) throw new Error('Forecast error');
        return r.json();
      }),
      needAurora
        ? fetch(auroraUrl, { signal }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
        : Promise.resolve(auroraCache.data),
      needSea
        ? fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${city.marine.lat}&longitude=${city.marine.lon}&current=sea_surface_temperature`, { signal })
            .then((r) => (r.ok ? r.json() : null)).catch(() => null)
        : Promise.resolve(city.marine ? seaCache.data : null)
    ];

    const [forecastRes, auroraRes, marineRes] = await Promise.allSettled(requests);
    if ((signal.aborted && !timedOut) || cityKey !== currentCityKey) return;

    if (forecastRes.status !== 'fulfilled' || !forecastRes.value) {
      throw new Error('Forecast failed');
    }

    const data = forecastRes.value;
    const auroraData = auroraRes.status === 'fulfilled' ? auroraRes.value : null;
    const marineData = marineRes.status === 'fulfilled' ? marineRes.value : null;
    if (needAurora && auroraData) auroraCache = { t: Date.now(), data: auroraData };
    if (needSea && marineData) seaCache = { t: Date.now(), data: marineData };

    cachedHourlyData = data.hourly;
    cachedDailyData = data.daily;
    lastCloudCover = data.current.cloud_cover;

    renderCurrent(data.current);
    evaluateSmartAlerts(data.current);
    renderDaily(data.daily);
    renderHourly();
    calculateMoonPhase();
    applyAuroraData(auroraData, data.current);
    const seaTemp = applySeaData(cityKey, marineData);
    updateStatsGridLayout();

    const formattedTime = new Date().toLocaleTimeString('lv-LV', { hour: '2-digit', minute: '2-digit' });
    setUpdateTime(formattedTime, true);
    lastFetchTimestamp = Date.now();

    try {
      localStorage.setItem(`laika_zinas_cache_${cityKey}`, JSON.stringify({
        forecast: data,
        seaTemp,
        updatedAt: formattedTime,
        savedAt: lastFetchTimestamp
      }));
    } catch (e) {}
  } catch (err) {
    if (err && err.name === 'AbortError' && !timedOut) return;
    const el = document.getElementById('updateTime');
    if (el) {
      // Ja ir iepriekšēji dati, parādām to laiku ar brīdinājumu; citādi "Kļūda"
      el.textContent = el.dataset.ok ? `⚠ ${el.dataset.ok}` : 'Kļūda';
    }
  } finally {
    clearTimeout(timer);
    if (activeFetchController === controller) {
      if (badge) badge.classList.remove('refreshing');
      if (progressBar) progressBar.classList.remove('active');
    }
  }
}

/* ---------- Brīdinājumi ---------- */

function isIceProne(temp, wet, code) {
  const wmo = decodeWMO(code);
  return wmo.ice || (temp >= -2.5 && temp <= 2.0 && (wet || wmo.wet));
}

function evaluateSmartAlerts(c) {
  const banner = document.getElementById('smartAlertBanner');
  if (!banner) return;

  const alerts = [];
  const wetNow = c.precipitation > 0;

  if (isIceProne(c.temperature_2m, wetNow, c.weather_code)) {
    alerts.push({ icon: 'ac_unit', text: 'Melnā ledus risks uz ceļa (temperatūra ap 0° un mitrs segums)' });
  } else if (cachedHourlyData && cachedHourlyData.time) {
    // Nākamo stundu skatiens: braucējam svarīgāks ir tas, kas gaidāms
    const nowHour = rigaNow().stamp.slice(0, 13);
    const start = cachedHourlyData.time.findIndex((t) => t.slice(0, 13) > nowHour);
    if (start !== -1) {
      for (let i = start; i < start + ICE_LOOKAHEAD_H && i < cachedHourlyData.time.length; i++) {
        if (isIceProne(cachedHourlyData.temperature_2m[i], cachedHourlyData.precipitation[i] > 0, cachedHourlyData.weather_code[i])) {
          alerts.push({ icon: 'ac_unit', text: `Melnā ledus risks tuvāko ${ICE_LOOKAHEAD_H} stundu laikā` });
          break;
        }
      }
    }
  }

  if (typeof c.visibility === 'number' && c.visibility < 500) {
    alerts.push({ icon: 'foggy', text: `Bieza migla uz ceļa · redzamība ${Math.round(c.visibility / 10) * 10} m` });
  }

  const gusts = c.wind_gusts_10m || c.wind_speed_10m;
  if (gusts >= 15) {
    alerts.push({ icon: 'air', text: `Spēcīgas vēja brāzmas līdz ${gusts.toFixed(1)} m/s` });
  }

  if (!alerts.length) {
    banner.style.display = 'none';
    banner.replaceChildren();
    return;
  }

  const rows = alerts.map((a) => {
    const row = makeEl('div', 'smart-alert-row');
    row.append(makeIcon(a.icon, 'icon icon-md'), makeEl('span', '', a.text));
    return row;
  });
  banner.replaceChildren(...rows);
  banner.style.display = 'flex';
}

/* ---------- Pašreizējais laiks ---------- */

function renderCurrent(c) {
  const wmo = decodeWMO(c.weather_code);
  const roundedTemp = Math.round(c.temperature_2m);
  document.getElementById('currentTemp').textContent = signed(roundedTemp);
  document.getElementById('currentApparentTemp').textContent = signed(Math.round(c.apparent_temperature));

  const isFogOrLowVis = [45, 48].includes(c.weather_code) || (typeof c.visibility === 'number' && c.visibility < 1000);
  const visText = (isFogOrLowVis && typeof c.visibility === 'number') ? ` · ${Math.round(c.visibility / 10) * 10} m` : '';
  document.getElementById('currentWeatherDesc').textContent = `${wmo.desc}${visText}`;
  setSvgIcon(document.getElementById('currentIcon'), wmo.icon);

  const windSpeedEl = document.getElementById('currentWindSpeed');
  windSpeedEl.textContent = `${c.wind_speed_10m.toFixed(1)} m/s`;
  windSpeedEl.className = getWindClass(c.wind_speed_10m);
  document.getElementById('currentWindDir').textContent = getWindDirection(c.wind_direction_10m);

  const windGustsEl = document.getElementById('currentWindGusts');
  if (typeof c.wind_gusts_10m === 'number' && c.wind_gusts_10m >= c.wind_speed_10m + 2.5) {
    windGustsEl.style.display = 'block';
    windGustsEl.textContent = `Brāzmas: ${c.wind_gusts_10m.toFixed(1)} m/s`;
  } else {
    windGustsEl.style.display = 'none';
  }

  // Šīs stundas nokrišņu varbūtība pēc API atgrieztā laika prefiksa
  let currentProb = 0;
  if (cachedHourlyData && cachedHourlyData.time && cachedHourlyData.precipitation_probability && c.time) {
    const hIdx = cachedHourlyData.time.findIndex((t) => t.startsWith(c.time.slice(0, 13)));
    if (hIdx !== -1) currentProb = cachedHourlyData.precipitation_probability[hIdx] || 0;
  }

  const precipPill = document.getElementById('currentPrecipPill');
  if (c.precipitation > 0 || c.snowfall > 0) {
    precipPill.style.display = 'flex';
    document.getElementById('currentPrecip').textContent =
      c.snowfall > 0 ? `${c.snowfall.toFixed(1)} cm sniegs` : `${c.precipitation.toFixed(1)} mm`;
    document.getElementById('currentPrecipProb').textContent = `Varbūtība: ${currentProb}%`;
    setSvgIcon(document.getElementById('currentPrecipIcon'), (c.snowfall > 0 || wmo.snow) ? 'ac_unit' : 'water_drop');
  } else {
    precipPill.style.display = 'none';
  }
}

/* ---------- Stundu prognoze ---------- */

function dailyIndexFor(dateStr) {
  if (!cachedDailyData || !cachedDailyData.time) return -1;
  return cachedDailyData.time.findIndex((t) => t.startsWith(dateStr));
}

function renderHourly(opts = {}) {
  if (!cachedHourlyData) return;
  const h = cachedHourlyData;
  const list = document.getElementById('hourlyList');
  const titleText = document.getElementById('hourlyTitleText');
  const resetBtn = document.getElementById('resetTodayBtn');
  const hourlyBox = document.getElementById('hourlyCardBox');
  if (!list) return;

  const now = rigaNow();
  const viewingToday = !selectedDateString || selectedDateString === now.date;

  if (viewingToday) {
    titleText.textContent = `Nākamās ${HOURS_AHEAD} stundas`;
    resetBtn.style.display = 'none';
    hourlyBox.classList.remove('day-selected-highlight');
  } else {
    titleText.textContent = `${WEEKDAYS_LV[parseLocalDate(selectedDateString).getDay()]} pa stundām`;
    resetBtn.style.display = 'inline-flex';
    hourlyBox.classList.add('day-selected-highlight');
  }

  // Indeksu diapazons, ko rādīt
  let start = -1;
  let end = -1;
  if (viewingToday) {
    const nowHour = now.stamp.slice(0, 13);
    start = h.time.findIndex((t) => t.slice(0, 13) >= nowHour);
    end = start === -1 ? -1 : Math.min(start + HOURS_AHEAD, h.time.length);
  } else {
    start = h.time.findIndex((t) => t.startsWith(selectedDateString));
    end = start === -1 ? -1 : start + 24;
  }

  if (start === -1) {
    list.replaceChildren(makeEl('div', 'empty-note', 'Stundu dati novecojuši. Pavelc uz leju, lai atjaunotu.'));
    return;
  }

  const prevScroll = list.scrollLeft;
  const fragment = document.createDocumentFragment();

  for (let i = start; i < end; i++) {
    const itemDate = h.time[i].slice(0, 10);
    if (!viewingToday && itemDate !== selectedDateString) break;

    const itemHour = parseInt(h.time[i].slice(11, 13), 10);
    const wmo = decodeWMO(h.weather_code[i]);
    const temp = Math.round(h.temperature_2m[i]);
    const isCurrentHour = viewingToday && i === start;
    const isTomorrow = viewingToday && itemDate !== now.date;
    const hWindCls = getWindClass(h.wind_speed_10m[i]);

    const item = makeEl('div', `hour-item${isCurrentHour ? ' active' : ''}`);
    item.dataset.hour = String(itemHour);

    const label = isCurrentHour ? 'Tagad' : `${isTomorrow ? 'Rīt ' : ''}${pad2(itemHour)}:00`;
    item.append(
      makeEl('span', 'hour-time', label),
      makeIcon(wmo.icon, 'icon icon-lg'),
      makeEl('span', 'hour-temp', signed(temp))
    );

    if ([45, 48].includes(h.weather_code[i]) && h.visibility && typeof h.visibility[i] === 'number') {
      const visSpan = makeEl('span', 'hour-precip', `${Math.round(h.visibility[i] / 10) * 10} m`);
      visSpan.style.color = 'var(--md-sys-color-on-surface)';
      item.appendChild(visSpan);
    } else if (h.precipitation[i] > 0 || (wmo.wet && h.precipitation_probability[i] >= 30)) {
      const mm = h.precipitation[i] > 0 ? ` (${h.precipitation[i].toFixed(1)}mm)` : '';
      item.appendChild(makeEl('span', 'hour-precip', `${h.precipitation_probability[i]}%${mm}`));
    }

    const windSpan = makeEl('span', 'hour-wind');
    windSpan.append(
      makeEl('span', hWindCls, h.wind_speed_10m[i].toFixed(1)),
      makeEl('span', 'wind-dir-letter', getWindDirection(h.wind_direction_10m[i]))
    );
    item.appendChild(windSpan);
    fragment.appendChild(item);

    // Saullēkts/saulriets kā teksts "YYYY-MM-DDTHH:MM" (bez ierīces laika joslas)
    const dIdx = dailyIndexFor(itemDate);
    if (dIdx !== -1 && cachedDailyData.sunrise && cachedDailyData.sunset) {
      [
        { str: cachedDailyData.sunrise[dIdx], icon: 'wb_twilight', text: 'Saullēkts' },
        { str: cachedDailyData.sunset[dIdx], icon: 'nights_stay', text: 'Saulriets' }
      ].forEach((ev) => {
        if (!ev.str || parseInt(ev.str.slice(11, 13), 10) !== itemHour) return;
        if (viewingToday && ev.str.slice(0, 16) < now.stamp) return;
        const card = makeEl('div', 'hour-item sun-event');
        card.append(
          makeEl('span', 'hour-time', ev.str.slice(11, 16)),
          makeIcon(ev.icon, 'icon icon-md'),
          makeEl('span', 'sun-label', ev.text)
        );
        fragment.appendChild(card);
      });
    }
  }

  list.replaceChildren(fragment);

  if (opts.scroll) {
    const morning = !viewingToday ? list.querySelector('[data-hour="7"]') : null;
    list.scrollTo({ left: morning ? morning.offsetLeft - 16 : 0, behavior: scrollBehavior() });
  } else {
    list.scrollLeft = prevScroll;   // automātiskā atjaunošana neizsit lietotāju no vietas
  }
}

/* ---------- Dienu prognoze ---------- */

function renderDaily(d) {
  const list = document.getElementById('dailyList');
  if (!list) return;

  const today = rigaNow().date;
  const todayIdx = d.time.findIndex((t) => t.startsWith(today));
  // Pirmā rādāmā diena = pirmā pēc šodienas (arī tad, ja kešs ir novecojis)
  let first = todayIdx !== -1 ? todayIdx + 1 : d.time.findIndex((t) => t.slice(0, 10) > today);
  if (first === -1) first = d.time.length;
  const tomorrowStr = first < d.time.length && todayIdx !== -1 ? d.time[first].slice(0, 10) : null;

  const fragment = document.createDocumentFragment();

  for (let i = first; i < Math.min(first + 7, d.time.length); i++) {
    const dateIsoStr = d.time[i].slice(0, 10);
    const date = parseLocalDate(dateIsoStr);
    const wmo = decodeWMO(d.weather_code[i]);
    const maxTemp = Math.round(d.temperature_2m_max[i]);
    const minTemp = Math.round(d.temperature_2m_min[i]);
    const dayName = dateIsoStr === tomorrowStr ? 'Rītdiena' : WEEKDAYS_LV[date.getDay()];
    const dateStr = `${date.getDate()}. ${MONTHS_LV[date.getMonth()]}`;

    const isSelected = selectedDateString === dateIsoStr;
    const card = makeEl('button', `day-card${isSelected ? ' active-day' : ''}`);
    card.type = 'button';
    card.setAttribute('aria-pressed', String(isSelected));
    card.dataset.date = dateIsoStr;
    card.addEventListener('click', () => selectDay(dateIsoStr));

    const hasPrecip = d.precipitation_sum[i] >= 0.1;
    let extra = hasPrecip ? ` · ${d.precipitation_sum[i].toFixed(1)} mm` : '';
    if ([45, 48].includes(d.weather_code[i]) && cachedHourlyData && cachedHourlyData.visibility) {
      let minVis = Infinity;
      cachedHourlyData.time.forEach((t, hIdx) => {
        const v = cachedHourlyData.visibility[hIdx];
        if (t.startsWith(dateIsoStr) && typeof v === 'number' && v < minVis) minVis = v;
      });
      if (minVis < Infinity) extra = ` · ${Math.round(minVis / 10) * 10} m`;
    }

    const nameBox = makeEl('div');
    nameBox.append(makeEl('div', 'day-name', dayName), makeEl('div', 'day-date', dateStr));

    const icon = makeIcon(wmo.icon, 'icon icon-lg');
    icon.style.color = 'var(--md-sys-color-primary)';

    const desc = makeEl('div', 'day-weather-desc');
    const precip = makeEl('span', 'precip-badge', `${wmo.desc}${extra}`);
    precip.style.color = hasPrecip ? 'var(--md-sys-color-precip)' : 'var(--md-sys-color-on-surface-variant)';
    if (!hasPrecip) precip.style.fontWeight = '500';
    const wind = makeEl('span', 'wind-detail');
    wind.append(
      makeEl('span', getWindClass(d.wind_speed_10m_max[i]), d.wind_speed_10m_max[i].toFixed(1)),
      makeEl('span', 'wind-dir-letter', getWindDirection(d.wind_direction_10m_dominant[i]))
    );
    desc.append(precip, wind);

    const right = makeEl('div', 'day-right-wrap');
    const range = makeEl('div', 'day-temp-range');
    range.append(makeEl('span', 'day-max', signed(maxTemp)), makeEl('span', 'day-min', signed(minTemp)));
    right.append(range, makeIcon('chevron_right', 'icon icon-xs day-chevron'));

    card.append(nameBox, icon, desc, right);
    fragment.appendChild(card);
  }

  if (!fragment.childNodes.length) {
    fragment.appendChild(makeEl('div', 'empty-note', 'Prognoze novecojusi. Pavelc uz leju, lai atjaunotu.'));
  }
  list.replaceChildren(fragment);
}

function markActiveDay() {
  document.querySelectorAll('.day-card').forEach((c) => {
    const active = c.dataset.date === selectedDateString;
    c.classList.toggle('active-day', active);
    c.setAttribute('aria-pressed', String(active));
  });
}

function selectDay(dateIsoStr) {
  if (selectedDateString === dateIsoStr) {
    selectToday();
    return;
  }
  selectedDateString = dateIsoStr;
  markActiveDay();
  renderHourly({ scroll: true });
  const section = document.getElementById('hourlySectionTitle');
  if (section) section.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
}

function selectToday() {
  selectedDateString = null;
  markActiveDay();
  renderHourly({ scroll: true });
}

/* ---------- Mēness, ziemeļblāzma, jūra ---------- */

function calculateMoonPhase() {
  const refNewMoon = Date.UTC(2000, 0, 6, 18, 14, 0);
  const synodicMonth = 29.53058867;
  const diffDays = (Date.now() - refNewMoon) / 86400000;
  const phaseCycle = (((diffDays % synodicMonth) + synodicMonth) % synodicMonth) / synodicMonth;
  const daysToFull = phaseCycle <= 0.5
    ? (0.5 - phaseCycle) * synodicMonth
    : (1.5 - phaseCycle) * synodicMonth;

  const nameEl = document.getElementById('moonPhaseName');
  const moonIconEl = document.getElementById('moonIcon');
  const dFull = Math.round(daysToFull);
  const isWaxing = phaseCycle <= 0.5;

  if (moonIconEl) {
    setSvgIcon(moonIconEl, dFull === 0 ? 'brightness_1' : 'bedtime');
    moonIconEl.style.transform = (dFull === 0 || isWaxing) ? 'none' : 'scaleX(-1)';
  }
  if (nameEl) {
    nameEl.textContent = dFull === 0 ? 'šodien' : (dFull === 1 ? 'rīt' : `pēc ${dFull} d.`);
  }
}

/** Vai šobrīd (Rīgā) ir tumšs: pirms saullēkta vai pēc saulrieta */
function isDarkNow() {
  const now = rigaNow();
  const idx = dailyIndexFor(now.date);
  if (idx === -1 || !cachedDailyData.sunrise || !cachedDailyData.sunset) return false;
  return now.stamp < cachedDailyData.sunrise[idx].slice(0, 16) || now.stamp > cachedDailyData.sunset[idx].slice(0, 16);
}

/** Ziemeļblāzma Latvijā: Kp ≥ 6, tumsa un ne pilnīgi apmācies */
function applyAuroraData(data, current) {
  const pillEl = document.getElementById('auroraPill');
  const hide = () => { if (pillEl) pillEl.style.display = 'none'; };

  if (!Array.isArray(data) || data.length < 2) return hide();
  const kp = parseFloat(data[data.length - 1][1]);
  const cloud = typeof current.cloud_cover === 'number' ? current.cloud_cover : 0;

  if (!(kp >= 6) || !isDarkNow() || cloud >= 80) return hide();

  pillEl.style.display = 'flex';
  document.getElementById('auroraKp').textContent = `Kp indekss: ${kp.toFixed(1)} / 9`;
  setSvgIcon(document.getElementById('auroraIcon'), 'auto_awesome');
  document.getElementById('auroraStatus').textContent = kp >= 7 ? 'Liela iespēja!' : 'Iespējama zemu pie horizonta';
}

function applySeaData(cityKey, data) {
  const pillEl = document.getElementById('seaTempPill');
  const valEl = document.getElementById('seaTempValue');

  if (!CITIES[cityKey].marine) {
    if (pillEl) pillEl.style.display = 'none';
    return null;
  }
  if (data && data.current && typeof data.current.sea_surface_temperature === 'number') {
    const temp = data.current.sea_surface_temperature;
    if (pillEl) pillEl.style.display = 'flex';
    if (valEl) valEl.textContent = `${temp > 0 ? '+' : ''}${temp.toFixed(1)} °C`;
    return temp;
  }
  if (pillEl) pillEl.style.display = 'none';
  return null;
}

function updateStatsGridLayout() {
  const grid = document.querySelector('.stats-grid');
  if (!grid) return;
  const pills = Array.from(grid.querySelectorAll('.stat-pill'));
  pills.forEach((p) => p.classList.remove('full-span'));
  const visible = pills.filter((p) => p.style.display !== 'none');
  if (visible.length % 2 === 1) visible[visible.length - 1].classList.add('full-span');
}

/* ---------- Webkamera ---------- */

(function initWebcam() {
  const dlg = document.getElementById('camDialog');
  const frame = document.getElementById('camFrame');
  document.getElementById('webcamBtn').addEventListener('click', (e) => {
    e.preventDefault();
    frame.src = CAM_SRC;             // straume ielādējas tikai pēc pieskāriena
    dlg.showModal();
  });
  document.getElementById('camClose').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => frame.removeAttribute('src'));   // aptur straumi
})();

/* ---------- Žesti ---------- */

(function initGestures() {
  const heroCard = document.getElementById('heroSwipeCard');
  const EDGE = 24;   // malas swipe atstāj pārlūka "atpakaļ" žestam
  let startX = 0;
  let startY = 0;

  heroCard.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  heroCard.addEventListener('touchend', (e) => {
    if (startX < EDGE || startX > window.innerWidth - EDGE) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      const idx = CITY_ORDER.indexOf(currentCityKey);
      if (dx < 0 && idx < CITY_ORDER.length - 1) switchCity(CITY_ORDER[idx + 1]);
      else if (dx > 0 && idx > 0) switchCity(CITY_ORDER[idx - 1]);
    }
  }, { passive: true });

  let ptrStartY = 0;
  let pulling = false;
  const ptrEl = document.getElementById('ptrIndicator');
  const ptrText = document.getElementById('ptrText');

  window.addEventListener('touchstart', (e) => {
    pulling = window.scrollY <= 2;
    if (pulling) ptrStartY = e.touches[0].clientY;
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - ptrStartY;
    if (dy > 20 && window.scrollY <= 2) {
      ptrEl.style.transition = 'none';   // bez nobīdes, kamēr velk
      ptrEl.style.height = `${Math.min(44, (dy - 20) * 0.45)}px`;
      ptrText.textContent = dy > 95 ? 'Atlaid, lai atjaunotu' : 'Velc uz leju, lai atjaunotu';
    }
  }, { passive: true });

  window.addEventListener('touchend', (e) => {
    if (!pulling) return;
    const dy = e.changedTouches[0].clientY - ptrStartY;
    ptrEl.style.transition = '';
    ptrEl.style.height = '0px';
    pulling = false;
    if (dy > 95 && window.scrollY <= 2) fetchWeatherData(true);
  }, { passive: true });
})();

/* ---------- Notikumi un inicializācija ---------- */

document.querySelectorAll('.city-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchCity(btn.dataset.city));
});
document.getElementById('refreshBtn').addEventListener('click', () => fetchWeatherData(true));
document.getElementById('resetTodayBtn').addEventListener('click', selectToday);

// Atgriežoties no fona, atjaunojam, ja dati vecāki par 10 min
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastFetchTimestamp > FRESH_MS) {
    fetchWeatherData(true);
  }
});

applyCityUI(currentCityKey);
const initialSnap = restoreCachedCitySnapshot(currentCityKey);
calculateMoonPhase();
updateStatsGridLayout();
fetchWeatherData(initialSnap.found && initialSnap.age > STALE_MS);

setInterval(() => {
  if (document.visibilityState === 'visible') fetchWeatherData(false);
}, 15 * 60 * 1000);
