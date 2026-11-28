export const schema = "bridge-radio.analytics.v1";
export const metrics = ["plays", "followers", "followerChange", "likes", "comments", "shares", "publications", "responses", "audioMinutes", "aiMinutes", "shortMinutes", "prepMinutes", "humanMinutes"] as const;
export const platforms = ["spotify", "instagram", "tiktok", "youtube", "studio"] as const;
export const sources = ["metricool", "spotify-creators", "manual"] as const;
export const qualities = ["measured", "estimated", "manual", "missing"] as const;
export const topics = ["対話", "体験談", "制作", "時事", "その他"] as const;
export type Metric = typeof metrics[number];
export type Row = {
  platform: typeof platforms[number]; source: typeof sources[number]; quality: typeof qualities[number];
  metric: Metric; definition: string; start: string; end: string; acquiredAt: string; unit: "count" | "min"; value: number | null;
  entity?: string; basis?: "interval" | "lifetime"; topic?: typeof topics[number]; postedAt?: string;
};
const keys = ["platform", "source", "quality", "metric", "definition", "start", "end", "acquiredAt", "unit", "value", "entity", "basis", "topic", "postedAt"];
const dayMs = 86_400_000;
export const day = (at: number) => new Date(at + 32_400_000).toISOString().slice(0, 10);
export const dayStart = (date: string) => Date.parse(date + "T00:00:00+09:00");
const validDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(dayStart(value)) && day(dayStart(value)) === value;
const safeId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) && !/^(AIza|ghp_|sk-)/.test(value);
const catalog: Partial<Record<Row["platform"], Partial<Record<Metric, readonly string[]>>>> = {
  instagram: { plays: ["IGEV05", "IGRE13", "IGRE23", "IGPO28"], followers: ["IGEV01"], likes: ["IGRE10", "IGPO13"], comments: ["IGRE07","IGPO08"], shares: ["IGRE21","IGPO27"] },
  tiktok: { plays: ["TKEV02", "TKPO07"], followers: ["TKEV07"], likes: ["TKEV03","TKPO08"], comments: ["TKEV04","TKPO09"], shares: ["TKEV05","TKPO10"] },
  youtube: { plays: ["YTEV02","YTVI06","YTVP06"], followers: ["YTEV01"], followerChange: ["YTEV05_minus_YTEV06"], likes: ["YTEV07","YTVI09","YTVP09"], comments: ["YTEV09","YTVI11","YTVP11"], shares: ["YTVI12","YTVP12"] },
};

export function validate(row: unknown): Row {
  if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some(key => !keys.includes(key))) throw new Error("許可された指標項目のみ取り込めます。");
  const v = row as Row;
  if (!platforms.includes(v.platform) || !sources.includes(v.source) || !qualities.includes(v.quality) || !metrics.includes(v.metric) ||
    !validDay(v.start) || !validDay(v.end) || v.start > v.end ||
    typeof v.acquiredAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v.acquiredAt) ||
    !Number.isFinite(Date.parse(v.acquiredAt)) || v.unit !== (v.metric.endsWith("Minutes") ? "min" : "count") ||
    (v.value !== null && (!Number.isFinite(v.value) || Math.abs(v.value) > 1e12 || (v.unit === "count" && !Number.isSafeInteger(v.value)) || (v.value < 0 && v.metric !== "followerChange"))) ||
    (v.quality === "missing") !== (v.value === null) || (v.entity !== undefined && !safeId(v.entity)) ||
    (v.basis !== undefined && v.basis !== "interval" && (v.basis !== "lifetime" || !v.entity || v.start !== v.end)) ||
    (v.topic !== undefined && (!topics.includes(v.topic) || !v.entity)) ||
    (v.postedAt !== undefined && (!v.entity || !/^\d{4}-\d{2}-\d{2}T\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v.postedAt) || !Number.isFinite(Date.parse(v.postedAt))))) {
    throw new Error("指標・期間・単位・欠損の形式を確認してください。");
  }
  const definitionOK = v.source === "metricool" ? catalog[v.platform]?.[v.metric]?.includes(v.definition)
    : v.source === "spotify-creators" ? v.platform === "spotify" && ["plays","followers","responses","publications"].includes(v.metric) && v.definition === "spotify-" + v.metric
    : v.definition === "manual-" + v.metric && ["manual","estimated","missing"].includes(v.quality);
  if (!definitionOK) throw new Error("取得元と指標の定義が一致しません。");
  return Object.fromEntries(keys.filter(key => Object.prototype.hasOwnProperty.call(v, key)).map(key => [key, v[key as keyof Row]]).filter(([key, value]) => key !== "basis" || value !== "interval")) as Row;
}

export const seriesKey = (r: Row) => JSON.stringify([r.platform, r.source, r.definition, r.entity ?? "", r.basis ?? "interval"]);
const identity = (r: Row) => JSON.stringify([seriesKey(r), r.start, r.end]);
export function merge(rows: Row[], incoming: Row[]) {
  const byKey = new Map(rows.map(row => [identity(row), row]));
  let changed = 0;
  for (const row of incoming) {
    const key = identity(row);
    const previous = byKey.get(key);
    if (!previous || Date.parse(previous.acquiredAt) < Date.parse(row.acquiredAt)) {
      byKey.set(key, row); changed++;
    } else if (Date.parse(row.acquiredAt) === Date.parse(previous.acquiredAt) && keys.some(field => field !== "acquiredAt" &&
      row[field as keyof Row] !== previous[field as keyof Row])) {
      throw new Error("同じ取得日時の数値が食い違っています。");
    }
  }
  return { rows: [...byKey.values()], changed };
}

export function csvCells(input: string) {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "", quoted = false, closed = false;
  const pushCell = () => { row.push(cell); cell = ""; closed = false; };
  const pushRow = () => { pushCell(); if (row.some(Boolean)) records.push(row); row = []; };
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else cell += char;
    } else if (char === "\n") pushRow();
    else if (char === "\r" && input[i + 1] === "\n") continue;
    else if (char === ",") pushCell();
    else if (char === '"' && !cell && !closed) quoted = true;
    else if (closed || char === '"') throw new Error("CSVの引用符を確認してください。");
    else cell += char;
  }
  if (quoted) throw new Error("CSVの引用符が閉じていません。");
  pushRow();
  return records;
}
export function parseImport(text: string) {
  if (text.length > 1_000_000) throw new Error("1 MB以下のファイルを選んでください。");
  const input = text.replace(/^\uFEFF/, "").trim();
  let data: unknown[];
  if (input.startsWith("{")) {
    const value = JSON.parse(input);
    if (value?.schema !== schema || Object.keys(value).some(key => !["schema","rows"].includes(key)) || !Array.isArray(value.rows)) throw new Error("共通JSON形式を確認してください。");
    data = value.rows;
  } else {
    const [headers, ...rows] = csvCells(input);
    if (!headers?.length || new Set(headers).size !== headers.length || headers.some(header => !keys.includes(header))) throw new Error("共通CSVの列を確認してください。");
    data = rows.map(cells => {
      if (cells.length !== headers.length) throw new Error("CSVの列数が一致しません。");
      return Object.fromEntries(headers.flatMap<[string, string | number | null]>((key, i) => key === "value"
        ? [[key, cells[i].trim() === "" ? null : Number(cells[i])]]
        : cells[i] ? [[key, cells[i]]] : []));
    });
  }
  if (!data.length || data.length > 5000) throw new Error("1〜5,000件の指標を指定してください。");
  return data.map(validate);
}

export type Period = { start: string; end: string };
export function periods(at = Date.now()) {
  const date = day(at);
  const today = dayStart(date);
  const end = today - dayMs; // Use completed days only.
  const weekday = new Date(today + 32_400_000).getUTCDay();
  const week = today - ((weekday + 6) % 7) * dayMs;
  const month = dayStart(date.slice(0, 7) + "-01");
  const previousMonth = dayStart(day(month - dayMs).slice(0, 7) + "-01");
  const length = Math.min(end - month, month - previousMonth - dayMs);
  const period = (start: number, last: number) => ({ start: day(start), end: day(last) });
  return {
    week: period(week, end), previousWeek: period(week - 7 * dayMs, end - 7 * dayMs),
    month: period(month, month + length), previousMonth: period(previousMonth, previousMonth + length),
  };
}

export function observation(rows: Row[], period: Period) {
  if (period.end < period.start || rows[0]?.basis === "lifetime") return { value: null, qualities: ["missing"] };
  const exact = rows.find(row => row.start === period.start && row.end === period.end);
  if (exact) return { value: exact.value, qualities: [exact.quality] };
  const daily = rows.filter(row => row.start === row.end && row.start >= period.start && row.end <= period.end);
  if (rows[0]?.metric === "followers") {
    const last = daily.find(row => row.end === period.end);
    return { value: last?.value ?? null, qualities: last ? [last.quality] : ["missing"] };
  }
  const days = Math.round((dayStart(period.end) - dayStart(period.start)) / dayMs) + 1;
  return daily.length === days && daily.every(row => row.value !== null)
    ? { value: daily.reduce((sum, row) => sum + row.value!, 0), qualities: [...new Set(daily.map(row => row.quality))] }
    : { value: null, qualities: ["missing"] };
}

export function comparisons(rows: Row[], at = Date.now()) {
  const windows = periods(at);
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = seriesKey(row);
    const group = groups.get(key);
    if (group) group.push(row); else groups.set(key, [row]);
  }
  return [...groups.values()].map(group => {
    const { platform, metric, definition, source, entity, unit, basis } = group[0];
    const latest = group.reduce((a, b) => Date.parse(a.acquiredAt) > Date.parse(b.acquiredAt) ? a : b);
    const recent = [...group].sort((a, b) => a.end.localeCompare(b.end) || a.start.localeCompare(b.start)).slice(-14);
    return { platform, metric, definition, source, entity, unit, basis, acquiredAt: latest.acquiredAt, latest, recent,
      week: observation(group, windows.week), previousWeek: observation(group, windows.previousWeek),
      month: observation(group, windows.month), previousMonth: observation(group, windows.previousMonth) };
  });
}
