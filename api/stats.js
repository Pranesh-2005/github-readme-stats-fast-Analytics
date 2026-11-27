// Vercel serverless function: GET /api/stats
import { handleStats } from "../lib/stats.mjs";

export default function handler(req, res) {
  return handleStats(req, res);
}
