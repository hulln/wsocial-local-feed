import { runBackfill } from "../lib/wsocial-backfill.mjs";

function json(status, data) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default async function handler(request) {
  let scheduledPayload = null;

  try {
    scheduledPayload = await request.json();
  } catch {
    scheduledPayload = null;
  }

  try {
    const result = await runBackfill();

    return json(200, {
      ok: true,
      scheduledPayload,
      result,
    });
  } catch (error) {
    console.error(error);

    return json(500, {
      ok: false,
      error: error.message,
    });
  }
}

export const config = {
  schedule: "*/30 * * * *",
};
