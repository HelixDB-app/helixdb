/**
 * k6 smoke + baseline for helix-data-plane.
 *
 *   DATA_PLANE_URL=http://127.0.0.1:9847 \
 *   DATA_PLANE_API_KEY=... \
 *   PG_URL=postgresql://user:pass@host:5432/dbname \
 *   k6 run scripts/k6/data-plane-smoke.js
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

const connectTrend = new Trend("dp_connect_ms");
const schemasTrend = new Trend("dp_schemas_ms");
const queryTrend = new Trend("dp_query_ms");
const failRate = new Rate("dp_failures");

const base = __ENV.DATA_PLANE_URL || "http://127.0.0.1:9847";
const apiKey = __ENV.DATA_PLANE_API_KEY || "";
const pgUrl = __ENV.PG_URL || "";

function authHeaders(json) {
  const h = {};
  if (json) h["Content-Type"] = "application/json";
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

export const options = {
  vus: 3,
  duration: "30s",
  thresholds: {
    http_req_failed: ["rate<0.05"],
    dp_failures: ["rate<0.05"],
  },
};

export default function () {
  if (!pgUrl) {
    failRate.add(1);
    return;
  }

  const connectRes = http.post(
    `${base}/v1/connections`,
    JSON.stringify({ connection_string: pgUrl }),
    { headers: authHeaders(true) }
  );
  connectTrend.add(connectRes.timings.duration);
  if (!check(connectRes, { "connect 200": (r) => r.status === 200 })) {
    failRate.add(1);
    return;
  }
  const conn = connectRes.json();
  const cid = conn.connection_id;

  const schRes = http.get(`${base}/v1/connections/${cid}/schemas`, {
    headers: authHeaders(false),
  });
  schemasTrend.add(schRes.timings.duration);
  check(schRes, { "schemas 200": (r) => r.status === 200 });

  const qRes = http.post(
    `${base}/v1/connections/${cid}/query`,
    JSON.stringify({ sql: "SELECT 1 AS one" }),
    { headers: authHeaders(true) }
  );
  queryTrend.add(qRes.timings.duration);
  check(qRes, { "query 200": (r) => r.status === 200 });

  http.del(`${base}/v1/connections/${cid}`, { headers: authHeaders(false) });
  sleep(0.2);
}

export function setup() {
  if (!pgUrl) {
    console.error("Set PG_URL to a postgres connection string for k6 load test.");
  }
}
