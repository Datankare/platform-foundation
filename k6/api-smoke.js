import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.K6_BASE_URL || "http://localhost:3000";

export const options = {
  stages: [
    { duration: "10s", target: 5 },
    { duration: "30s", target: 5 },
    { duration: "10s", target: 0 },
  ],
  thresholds: {
    "http_req_duration{name:health}": ["p(99)<100"],
    http_req_failed: ["rate<0.01"],
  },
};

export default function () {
  const healthRes = http.get(`${BASE_URL}/api/health`, {
    tags: { name: "health" },
  });
  check(healthRes, {
    "health: status 200": (r) => r.status === 200,
  });

  sleep(1);
}
