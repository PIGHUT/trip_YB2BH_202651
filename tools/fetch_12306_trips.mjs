#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_BASE_URL = 'https://kyfw.12306.cn';
const LEFT_TICKET_PATHS = ['queryG', 'query'];

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function toAbsolute(baseDir, maybeRelative) {
  if (!maybeRelative) return maybeRelative;
  if (path.isAbsolute(maybeRelative)) return maybeRelative;
  return path.resolve(baseDir, maybeRelative);
}

function toDurationText(lishi) {
  const m = String(lishi || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return String(lishi || '');
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!h) return `${min}分`;
  return `${h}小时${min}分`;
}

function parsePriceNumber(raw) {
  const m = String(raw ?? '').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function chooseBestPrice(data) {
  if (!data || typeof data !== 'object') return null;
  let best = null;
  for (const v of Object.values(data)) {
    const n = parsePriceNumber(v);
    if (!Number.isFinite(n)) continue;
    if (best == null || n < best) best = n;
  }
  return best;
}

function normalizePairs(pairs) {
  if (!Array.isArray(pairs)) return [];
  return pairs
    .map((p) => {
      if (Array.isArray(p) && p.length >= 2) {
        return { from: String(p[0]).trim(), to: String(p[1]).trim() };
      }
      if (p && typeof p === 'object') {
        return {
          from: String(p.from || '').trim(),
          to: String(p.to || '').trim(),
        };
      }
      return null;
    })
    .filter((x) => x && x.from && x.to);
}

function buildHeaders(extraCookie) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    Referer: 'https://kyfw.12306.cn/otn/leftTicket/init',
  };
  if (extraCookie) headers.Cookie = extraCookie;
  return headers;
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

async function loadStationMaps(baseUrl, headers) {
  const url = `${baseUrl}/otn/resources/js/framework/station_name.js`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`无法下载站点代码表: HTTP ${res.status}`);
  }
  const text = await res.text();
  const nameToCode = new Map();
  const codeToName = new Map();
  const re = /@([^|]+)\|([^|]+)\|([A-Z]+)\|/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const cnName = match[2];
    const code = match[3];
    nameToCode.set(cnName, code);
    codeToName.set(code, cnName);
  }
  if (nameToCode.size < 100) {
    throw new Error('站点代码表解析失败，结果过少');
  }
  return { nameToCode, codeToName };
}

function parseLeftTicketRows(resultRows, codeToName) {
  if (!Array.isArray(resultRows)) return [];
  const out = [];
  for (const row of resultRows) {
    const f = String(row).split('|');
    if (f.length < 36) continue;
    out.push({
      train_no: f[2],
      station_train_code: f[3],
      from_station_telecode: f[6],
      to_station_telecode: f[7],
      start_time: f[8],
      arrive_time: f[9],
      lishi: f[10],
      train_date: f[13],
      from_station_no: f[16],
      to_station_no: f[17],
      seat_types: f[35],
      from_station_name: codeToName.get(f[6]) || f[6],
      to_station_name: codeToName.get(f[7]) || f[7],
    });
  }
  return out;
}

async function queryLeftTickets(baseUrl, headers, date, fromCode, toCode, purposeCodes) {
  for (const pathName of LEFT_TICKET_PATHS) {
    const url = new URL(`${baseUrl}/otn/leftTicket/${pathName}`);
    url.searchParams.set('leftTicketDTO.train_date', date);
    url.searchParams.set('leftTicketDTO.from_station', fromCode);
    url.searchParams.set('leftTicketDTO.to_station', toCode);
    url.searchParams.set('purpose_codes', purposeCodes);
    try {
      const json = await fetchJson(url.toString(), headers);
      if (json && json.status && json.data && Array.isArray(json.data.result)) {
        return json.data.result;
      }
    } catch (err) {
      // keep trying with the next path
    }
  }
  return [];
}

async function queryBestPrice(baseUrl, headers, ticket, date) {
  const url = new URL(`${baseUrl}/otn/leftTicket/queryTicketPrice`);
  url.searchParams.set('train_no', ticket.train_no);
  url.searchParams.set('from_station_no', ticket.from_station_no);
  url.searchParams.set('to_station_no', ticket.to_station_no);
  url.searchParams.set('seat_types', ticket.seat_types || '');
  url.searchParams.set('train_date', date);
  try {
    const json = await fetchJson(url.toString(), headers);
    return chooseBestPrice(json && json.data);
  } catch {
    return null;
  }
}

function buildTripRecord(ticket, pair, saleTimeByStation, price, defaultPrice) {
  const from = ticket.from_station_name || pair.from;
  const to = ticket.to_station_name || pair.to;
  const saleTime = saleTimeByStation[from] || '';
  const finalPrice = Number.isFinite(price) ? price : defaultPrice;
  const priceNote = Number.isFinite(price) ? '12306接口抓取' : `12306接口未返回票价，已使用默认值${defaultPrice}`;
  return {
    线路: `${pair.from}<>${pair.to}`,
    出发时间: ticket.start_time,
    到达时间: ticket.arrive_time,
    出发站点: from,
    到达站点: to,
    车号: ticket.station_train_code,
    起售时间: saleTime,
    乘车时长: toDurationText(ticket.lishi),
    '价格(元)': finalPrice,
    截图文件: 'crawler:12306',
    夸克比对结果: priceNote,
  };
}

function dedupeTrips(trips) {
  const map = new Map();
  trips.forEach((t) => {
    const k = [
      t.线路,
      t.出发站点,
      t.到达站点,
      t.车号,
      t.出发时间,
      t.到达时间,
    ].join('|');
    if (!map.has(k)) map.set(k, t);
  });
  return [...map.values()];
}

function usageAndExit() {
  console.error('用法: node tools/fetch_12306_trips.mjs --config tools/return-config.example.json [--date 2026-05-06] [--output ./beihai-yibin-return-data.js]');
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.config) usageAndExit();

  const cwd = process.cwd();
  const configPath = toAbsolute(cwd, args.config);
  const configRaw = await fs.readFile(configPath, 'utf8');
  const config = JSON.parse(configRaw);

  const date = String(args.date || config.date || '').trim();
  const outputPath = toAbsolute(cwd, args.output || config.output || 'return-data.js');
  const windowVar = String(args.var || config.windowVar || 'YIBIN_BEIHAI_DATA').trim();
  const baseUrl = String(config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const purposeCodes = String(config.purposeCodes || 'ADULT');
  const fetchPrice = config.fetchPrice !== false;
  const defaultPrice = Number.isFinite(Number(config.defaultPrice)) ? Number(config.defaultPrice) : 9999;
  const saleTimeByStation = config.saleTimeByStation && typeof config.saleTimeByStation === 'object'
    ? config.saleTimeByStation
    : {};
  const pairs = normalizePairs(config.pairs);
  const cookie = String(args.cookie || config.cookie || process.env.C12306_COOKIE || '').trim();
  const headers = buildHeaders(cookie);

  if (!date) throw new Error('缺少 date，请在 config 或 --date 里提供，例如 2026-05-06');
  if (!pairs.length) throw new Error('缺少 pairs，请在 config 中配置返程抓取线路');

  const { nameToCode, codeToName } = await loadStationMaps(baseUrl, headers);
  const allTrips = [];

  for (const pair of pairs) {
    const fromCode = nameToCode.get(pair.from);
    const toCode = nameToCode.get(pair.to);
    if (!fromCode || !toCode) {
      console.warn(`[skip] 站点未匹配: ${pair.from} -> ${pair.to}`);
      continue;
    }

    const resultRows = await queryLeftTickets(baseUrl, headers, date, fromCode, toCode, purposeCodes);
    const tickets = parseLeftTicketRows(resultRows, codeToName);
    console.log(`[pair] ${pair.from} -> ${pair.to}: ${tickets.length} 条`);

    for (const ticket of tickets) {
      const bestPrice = fetchPrice
        ? await queryBestPrice(baseUrl, headers, ticket, date)
        : null;
      allTrips.push(buildTripRecord(ticket, pair, saleTimeByStation, bestPrice, defaultPrice));
      // 小节流，降低风控概率
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  const deduped = dedupeTrips(allTrips).sort((a, b) =>
    String(a.线路).localeCompare(String(b.线路), 'zh-Hans-CN') ||
    String(a.出发时间).localeCompare(String(b.出发时间), 'zh-Hans-CN') ||
    String(a.车号).localeCompare(String(b.车号), 'zh-Hans-CN')
  );

  const outputObj = {
    generated_from: `crawler:12306:${date}`,
    trip_count: deduped.length,
    trips: deduped,
  };

  const content = `window.${windowVar} = ${JSON.stringify(outputObj, null, 2)};\n`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, content, 'utf8');

  console.log(`已导出 ${deduped.length} 条 -> ${outputPath}`);
  console.log(`window变量名: ${windowVar}`);
}

main().catch((err) => {
  console.error('[error]', err && err.message ? err.message : err);
  process.exit(1);
});

